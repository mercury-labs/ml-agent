import { Command } from "commander";

import {
  resolveDefaultChannel,
  resolveLinearApiKey,
  resolveLinearStateMap,
  resolveLinearStateSync,
  resolveLinearTeamId,
  resolveLinearTeamKey,
  resolveToken
} from "../lib/config";
import { LinearClient } from "../lib/linear-client";
import { parseMessageUrl, resolveChannelId } from "../lib/resolvers";
import { SlackListsClient } from "../lib/slack-client";
import { getThreadEntries, setThreadEntry, ThreadEntry } from "../lib/thread-map";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

const VIEWER_QUERY = `
  query Viewer {
    viewer {
      id
      name
      email
    }
  }
`;

const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        key
        name
      }
    }
  }
`;

const TEAM_STATES_QUERY = `
  query TeamStates($teamId: String!) {
    team(id: $teamId) {
      id
      name
      states {
        nodes {
          id
          name
          type
          position
        }
      }
    }
  }
`;

const TEAM_CYCLES_QUERY = `
  query TeamCycles($teamId: String!, $first: Int!) {
    team(id: $teamId) {
      id
      name
      cycles(first: $first) {
        nodes {
          id
          name
          number
          startsAt
          endsAt
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      team {
        id
        name
      }
      state {
        id
        name
        type
      }
      assignee {
        id
        name
        email
      }
      cycle {
        id
        name
      }
      attachments {
        nodes {
          id
          url
          title
          subtitle
        }
      }
      updatedAt
      createdAt
    }
  }
`;

const ATTACHMENT_CREATE_MUTATION = `
  mutation AttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment {
        id
        url
      }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        state {
          id
          name
          type
        }
      }
    }
  }
`;

export function registerLinearCommands(program: Command): void {
  const linear = program.command("linear").description("Linear helpers (auth, teams, states, Slack threads)");

  linear
    .command("auth")
    .description("Linear authentication helpers")
    .command("status")
    .description("Verify Linear token works")
    .action(async (_options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const result = await client.request<{ viewer: Record<string, unknown> }>(VIEWER_QUERY);
        outputJson({ ok: true, viewer: result.viewer });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  linear
    .command("teams")
    .description("List Linear teams")
    .action(async (_options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const result = await client.request<{ teams: { nodes: Array<Record<string, unknown>> } }>(TEAMS_QUERY);
        outputJson({ ok: true, teams: result.teams.nodes });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  linear
    .command("states")
    .description("List workflow states for a team")
    .option("--team <team-id>", "Team ID")
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const teamId = await resolveTeamId(client, options.team);
        const result = await client.request<TeamStatesResponse>(TEAM_STATES_QUERY, { teamId });
        outputJson({ ok: true, team: result.team, states: result.team?.states?.nodes ?? [] });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  linear
    .command("cycles")
    .description("List cycles for a team")
    .option("--team <team-id>", "Team ID")
    .option("--limit <count>", "Maximum cycles to return", "15")
    .option("--current", "Return only the current cycle", false)
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const teamId = await resolveTeamId(client, options.team);
        const limit = parseLimit(options.limit);
        const result = await client.request<TeamCyclesResponse>(TEAM_CYCLES_QUERY, {
          teamId,
          first: limit
        });

        const cycles = (result.team?.cycles?.nodes ?? []).filter(Boolean);
        const current = findCurrentCycle(cycles);

        if (options.current) {
          outputJson({
            ok: Boolean(current),
            team_id: teamId,
            current_cycle: current ?? null
          });
          return;
        }

        outputJson({
          ok: true,
          team_id: teamId,
          current_cycle: current ?? null,
          cycles
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  const threads = linear.command("threads").description("Manage Slack threads for Linear issues");

  threads
    .command("list")
    .description("List Slack threads for a Linear issue")
    .argument("<issue-id>", "Linear issue ID or identifier")
    .action(async (issueId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const linear = getLinearClient();
        const issue = await fetchIssue(linear, issueId);
        const teamId = issue.team?.id;
        const storedEntries = await getThreadEntries(linearThreadScope(teamId), issueId);
        const attachmentEntries = extractThreadsFromIssue(issue);
        const combined = mergeThreadEntries(storedEntries, attachmentEntries);
        const latest = selectThreadEntry(combined);

        outputJson({
          ok: true,
          issue_id: issueId,
          latest_thread: latest ?? null,
          threads: combined
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  threads
    .command("set")
    .description("Store a Slack thread mapping for a Linear issue")
    .argument("<issue-id>", "Linear issue ID or identifier")
    .option("--message-url <url>", "Slack message URL")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--label <label>", "Label for the thread")
    .option("--state <state>", "State for the thread")
    .option("--attach", "Attach the thread permalink to Linear", false)
    .option("--sync-state", "Sync Linear state when thread state is provided", false)
    .action(async (issueId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const slackClient = new SlackListsClient(resolveToken(globals));

      try {
        const linear = getLinearClient();
        const issue = await fetchIssue(linear, issueId);
        const teamId = issue.team?.id;

        const url = options.messageUrl as string | undefined;
        let channel = options.channel ? await resolveChannelId(slackClient, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;

        if (url) {
          const parsed = parseMessageUrl(url);
          if (!parsed) {
            throw new Error("Unable to parse message URL");
          }
          channel = channel ?? parsed.channel;
          threadTs = threadTs ?? parsed.ts;
        }

        if (!channel || !threadTs) {
          throw new Error("Provide --message-url or both --channel and --thread-ts");
        }

        if (options.attach && url) {
          await createThreadAttachment(linear, issue.id, url, channel, threadTs, {
            label: options.label as string | undefined,
            state: options.state as string | undefined
          });
        }

        await setThreadEntry(linearThreadScope(teamId), issueId, {
          permalink: url,
          channel,
          ts: threadTs,
          label: options.label as string | undefined,
          state: options.state as string | undefined
        });

        const stateSync = await maybeSyncIssueState({
          client: linear,
          issue,
          threadState: options.state as string | undefined,
          syncRequested: Boolean(options.syncState)
        });

        outputJson({
          ok: true,
          issue_id: issueId,
          channel,
          thread_ts: threadTs,
          permalink: url,
          label: options.label as string | undefined,
          state: options.state as string | undefined,
          state_sync: stateSync ?? undefined
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  linear
    .command("comment")
    .description("Post a Slack comment for a Linear issue")
    .argument("<issue-id>", "Linear issue ID or identifier")
    .argument("<text>", "Comment text")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--message-url <url>", "Slack message URL to infer thread")
    .option("--thread-label <label>", "Label to store for the thread")
    .option("--thread-state <state>", "State to store for the thread")
    .option("--sync-state", "Sync Linear state when thread state is provided", false)
    .action(async (issueId: string, text: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const slackClient = new SlackListsClient(resolveToken(globals));

      try {
        const linear = getLinearClient();
        const issue = await fetchIssue(linear, issueId);
        const teamId = issue.team?.id;

        const threadLabel = options.threadLabel as string | undefined;
        const threadState = options.threadState as string | undefined;

        let channel = options.channel ? await resolveChannelId(slackClient, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;
        let messageUrl = options.messageUrl as string | undefined;

        if ((!channel || !threadTs) && messageUrl) {
          const parsed = parseMessageUrl(messageUrl);
          if (parsed) {
            channel = channel ?? parsed.channel;
            threadTs = threadTs ?? parsed.ts;
          }
        }

        const storedEntries = await getThreadEntries(linearThreadScope(teamId), issueId);
        const attachmentEntries = extractThreadsFromIssue(issue);
        const combined = mergeThreadEntries(storedEntries, attachmentEntries);
        const preferred = selectThreadEntry(combined, threadLabel);

        if (!channel || !threadTs) {
          if (preferred) {
            channel = channel ?? preferred.channel;
            threadTs = threadTs ?? preferred.ts;
            messageUrl = messageUrl ?? preferred.permalink;
          }
        }

        if (!channel) {
          const fallback = resolveDefaultChannel();
          if (fallback) {
            channel = await resolveChannelId(slackClient, fallback);
          }
        }

        if (!threadTs && channel) {
          const rootText = buildLinearThreadRootText(issue);
          const root = await slackClient.postMessage({ channel, text: rootText });
          const rootTs = (root as { ts?: string }).ts;
          if (!rootTs) {
            throw new Error("Unable to create thread root message");
          }
          const permalinkResult = await slackClient.call("chat.getPermalink", {
            channel,
            message_ts: rootTs
          });
          const permalink = (permalinkResult as { permalink?: string }).permalink;
          if (!permalink) {
            throw new Error("Unable to fetch permalink for thread root");
          }

          await createThreadAttachment(linear, issue.id, permalink, channel, rootTs, {
            label: threadLabel,
            state: threadState
          });

          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink,
            channel,
            ts: rootTs,
            label: threadLabel,
            state: threadState
          });

          messageUrl = permalink;
          threadTs = rootTs;
        }

        if (!channel || !threadTs) {
          throw new Error(
            "Unable to infer thread. Provide --channel and --thread-ts or --message-url, or set SLACK_LIST_DEFAULT_CHANNEL."
          );
        }

        const result = await slackClient.postMessage({ channel, text, thread_ts: threadTs });

        if (messageUrl || (channel && threadTs)) {
          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink: messageUrl,
            channel,
            ts: threadTs,
            label: threadLabel,
            state: threadState
          });
        }

        const stateSync = await maybeSyncIssueState({
          client: linear,
          issue,
          threadState,
          syncRequested: Boolean(options.syncState)
        });

        outputJson({
          ...result,
          state_sync: stateSync ?? undefined
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  linear
    .command("comments")
    .description("List Slack thread messages for a Linear issue")
    .argument("<issue-id>", "Linear issue ID or identifier")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--message-url <url>", "Slack message URL to infer thread")
    .option("--thread-label <label>", "Select a thread by label")
    .option("--limit <count>", "Maximum messages to return", "200")
    .option("--compact", "Return only user/text/ts fields", false)
    .action(async (issueId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const slackClient = new SlackListsClient(resolveToken(globals));

      try {
        const linear = getLinearClient();
        const issue = await fetchIssue(linear, issueId);
        const teamId = issue.team?.id;

        let channel = options.channel ? await resolveChannelId(slackClient, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;
        let messageUrl = options.messageUrl as string | undefined;
        const threadLabel = options.threadLabel as string | undefined;

        if ((!channel || !threadTs) && messageUrl) {
          const parsed = parseMessageUrl(messageUrl);
          if (parsed) {
            channel = channel ?? parsed.channel;
            threadTs = threadTs ?? parsed.ts;
          }
        }

        const storedEntries = await getThreadEntries(linearThreadScope(teamId), issueId);
        const attachmentEntries = extractThreadsFromIssue(issue);
        const combined = mergeThreadEntries(storedEntries, attachmentEntries);
        const preferred = selectThreadEntry(combined, threadLabel);

        if (!channel || !threadTs) {
          if (preferred) {
            channel = channel ?? preferred.channel;
            threadTs = threadTs ?? preferred.ts;
            messageUrl = messageUrl ?? preferred.permalink;
          }
        }

        if (!channel || !threadTs) {
          throw new Error("Unable to infer thread. Provide --channel and --thread-ts or --message-url.");
        }

        const limit = Number(options.limit);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error("--limit must be a positive number");
        }

        const messages: Array<Record<string, unknown>> = [];
        let cursor: string | undefined = undefined;
        let remaining = limit;

        do {
          const batchSize = Math.min(remaining, 200);
          const result = await slackClient.call("conversations.replies", {
            channel,
            ts: threadTs,
            limit: batchSize,
            cursor
          });

          const page = (result as { messages?: Array<Record<string, unknown>> }).messages ?? [];
          messages.push(...page);

          cursor = (result as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;
          remaining = limit - messages.length;
          if (remaining <= 0) {
            break;
          }
        } while (cursor);

        const trimmed = messages.slice(0, limit);
        const payload = options.compact
          ? trimmed.map((message) => ({
              ts: message.ts,
              user: message.user,
              text: message.text,
              thread_ts: message.thread_ts
            }))
          : trimmed;

        if ((messageUrl || (channel && threadTs)) && channel && threadTs) {
          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink: messageUrl,
            channel,
            ts: threadTs,
            label: threadLabel
          });
        }

        outputJson({
          ok: true,
          channel,
          thread_ts: threadTs,
          message_count: trimmed.length,
          messages: payload
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

type TeamStatesResponse = {
  team?: {
    id?: string;
    name?: string;
    states?: { nodes?: Array<{ id?: string; name?: string; type?: string }> };
  };
};

type TeamCyclesResponse = {
  team?: {
    id?: string;
    name?: string;
    cycles?: { nodes?: CycleNode[] };
  };
};

type LinearIssue = {
  id: string;
  identifier?: string;
  title?: string;
  state?: { id?: string; name?: string; type?: string };
  team?: { id?: string; name?: string };
  attachments?: { nodes?: Array<{ url?: string }> };
};

type CycleNode = {
  id?: string;
  name?: string;
  number?: number;
  startsAt?: string;
  endsAt?: string;
};

function getLinearClient(): LinearClient {
  const apiKey = resolveLinearApiKey();
  if (!apiKey) {
    throw new Error("Missing Linear API key. Set LINEAR_API_KEY or .ml-agent.config.json");
  }
  return new LinearClient(apiKey);
}

async function resolveTeamId(client: LinearClient, option?: string): Promise<string> {
  const configured = resolveLinearTeamId();
  const configuredKey = resolveLinearTeamKey();
  const candidate = option ?? configured;

  if (candidate && looksLikeId(candidate)) {
    return candidate;
  }

  const key = candidate ?? configuredKey;
  if (!key) {
    throw new Error(
      "Provide --team (id or key) or set LINEAR_TEAM_ID / LINEAR_TEAM_KEY / .ml-agent.config.json"
    );
  }

  const resolved = await resolveTeamIdByKey(client, key);
  if (!resolved) {
    throw new Error(`Unable to resolve Linear team for key: ${key}`);
  }
  return resolved;
}

async function fetchIssue(client: LinearClient, issueId: string): Promise<LinearIssue> {
  const result = await client.request<{ issue?: LinearIssue }>(ISSUE_QUERY, { id: issueId });
  if (!result.issue) {
    throw new Error("Linear issue not found");
  }
  return result.issue;
}

function linearThreadScope(teamId?: string): string {
  return teamId ? `linear:${teamId}` : "linear";
}

function extractThreadsFromIssue(issue: LinearIssue): ThreadEntry[] {
  const attachments = issue.attachments?.nodes ?? [];
  const entries: ThreadEntry[] = [];
  for (const attachment of attachments) {
    if (!attachment?.url) {
      continue;
    }
    if (!attachment.url.includes("slack.com/archives/")) {
      continue;
    }
    const parsed = parseMessageUrl(attachment.url);
    if (parsed) {
      entries.push({ permalink: attachment.url, channel: parsed.channel, ts: parsed.ts });
    }
  }
  return entries;
}

function buildLinearThreadRootText(issue: LinearIssue): string {
  const identifier = issue.identifier ? `${issue.identifier}` : "issue";
  const title = issue.title ? `: ${issue.title}` : "";
  return `Thread for Linear ${identifier}${title}`;
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? 15);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return limit;
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f-]{32,36}$/i.test(value);
}

async function resolveTeamIdByKey(client: LinearClient, teamKey: string): Promise<string | null> {
  const result = await client.request<{ teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> } }>(
    TEAMS_QUERY
  );
  const teams = result.teams?.nodes ?? [];
  const normalized = teamKey.toLowerCase();
  const match = teams.find(
    (team) =>
      (team.key && team.key.toLowerCase() === normalized) ||
      (team.name && team.name.toLowerCase() === normalized)
  );
  return match?.id ?? null;
}

async function maybeSyncIssueState({
  client,
  issue,
  threadState,
  syncRequested
}: {
  client: LinearClient;
  issue: LinearIssue;
  threadState?: string;
  syncRequested: boolean;
}): Promise<{ synced: boolean; from?: string; to?: string; error?: string } | null> {
  if (!threadState) {
    return null;
  }

  const map = resolveLinearStateMap();
  if (!map || Object.keys(map).length === 0) {
    return null;
  }

  const shouldSync = syncRequested || resolveLinearStateSync();
  if (!shouldSync) {
    return null;
  }

  const mapped = resolveMappedState(map, threadState);
  if (!mapped) {
    return { synced: false, error: `No state mapping for thread state: ${threadState}` };
  }

  const teamId = issue.team?.id;
  if (!teamId) {
    return { synced: false, error: "Issue missing team id for state sync" };
  }

  try {
    const stateId = await resolveStateId(client, teamId, mapped);
    const currentStateId = issue.state?.id;
    if (stateId && currentStateId === stateId) {
      return { synced: true, from: issue.state?.name, to: issue.state?.name };
    }

    await client.request(ISSUE_UPDATE_MUTATION, {
      id: issue.id,
      input: {
        stateId
      }
    });

    return { synced: true, from: issue.state?.name, to: mapped };
  } catch (error) {
    return { synced: false, error: (error as Error).message };
  }
}

function resolveMappedState(map: Record<string, string>, threadState: string): string | null {
  const normalized = threadState.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return null;
}

async function resolveStateId(
  client: LinearClient,
  teamId: string,
  input: string
): Promise<string | undefined> {
  if (looksLikeId(input)) {
    return input;
  }

  const result = await client.request<TeamStatesResponse>(TEAM_STATES_QUERY, { teamId });
  const states = result.team?.states?.nodes ?? [];
  const normalized = input.toLowerCase();
  const match = states.find((state) => state.name?.toLowerCase() === normalized);
  if (!match?.id) {
    throw new Error(`Unknown Linear state: ${input}`);
  }
  return match.id;
}

function findCurrentCycle(cycles: CycleNode[]): CycleNode | null {
  const now = new Date();
  const candidates = cycles.filter((cycle) => cycle?.startsAt && cycle?.endsAt);
  for (const cycle of candidates) {
    const start = new Date(cycle.startsAt!);
    const end = new Date(cycle.endsAt!);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf())) {
      if (start <= now && now <= end) {
        return cycle;
      }
    }
  }
  return null;
}

async function createThreadAttachment(
  client: LinearClient,
  issueId: string,
  permalink: string,
  channel: string,
  threadTs: string,
  meta?: { label?: string; state?: string }
): Promise<void> {
  try {
    await client.request(ATTACHMENT_CREATE_MUTATION, {
      input: {
        issueId,
        title: "Slack thread",
        subtitle: channel,
        url: permalink,
        metadata: {
          channel,
          thread_ts: threadTs,
          label: meta?.label,
          state: meta?.state
        }
      }
    });
  } catch {
    // Best effort; attachment is optional if the org disallows it
  }
}

function mergeThreadEntries(existing: ThreadEntry[], incoming: ThreadEntry[]): ThreadEntry[] {
  const merged = [...existing];
  for (const entry of incoming) {
    if (!entry) {
      continue;
    }
    const exists = merged.some((candidate) => matchesThread(candidate, entry));
    if (!exists) {
      merged.push(entry);
    }
  }
  return sortThreads(merged);
}

function selectThreadEntry(entries: ThreadEntry[], label?: string): ThreadEntry | null {
  if (entries.length === 0) {
    return null;
  }
  const sorted = sortThreads(entries);
  if (label) {
    const normalized = label.toLowerCase();
    const labeled = sorted.filter((entry) => entry.label?.toLowerCase() === normalized);
    if (labeled.length > 0) {
      return labeled[labeled.length - 1];
    }
  }
  return sorted[sorted.length - 1];
}

function sortThreads(entries: ThreadEntry[]): ThreadEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const timeDiff = parseThreadTime(a.entry) - parseThreadTime(b.entry);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function matchesThread(a: ThreadEntry, b: ThreadEntry): boolean {
  if (a.ts && b.ts && a.ts === b.ts) {
    return true;
  }
  if (a.permalink && b.permalink && a.permalink === b.permalink) {
    return true;
  }
  if (a.channel && b.channel && a.ts && b.ts) {
    return a.channel === b.channel && a.ts === b.ts;
  }
  return false;
}

function parseThreadTime(entry: ThreadEntry): number {
  if (entry.updated_at) {
    const time = Date.parse(entry.updated_at);
    if (!Number.isNaN(time)) {
      return time;
    }
  }
  if (entry.created_at) {
    const time = Date.parse(entry.created_at);
    if (!Number.isNaN(time)) {
      return time;
    }
  }
  return 0;
}
