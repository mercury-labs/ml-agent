import { Command } from "commander";

import { resolveDefaultChannel, resolveLinearApiKey, resolveLinearTeamId, resolveToken } from "../lib/config";
import { LinearClient } from "../lib/linear-client";
import { parseMessageUrl, resolveChannelId } from "../lib/resolvers";
import { SlackListsClient } from "../lib/slack-client";
import { getThreadEntry, setThreadEntry } from "../lib/thread-map";
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
        const teamId = resolveTeamId(options.team);
        const client = getLinearClient();
        const result = await client.request<TeamStatesResponse>(TEAM_STATES_QUERY, { teamId });
        outputJson({ ok: true, team: result.team, states: result.team?.states?.nodes ?? [] });
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
    .action(async (issueId: string, text: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const slackClient = new SlackListsClient(resolveToken(globals));

      try {
        const linear = getLinearClient();
        const issue = await fetchIssue(linear, issueId);
        const teamId = issue.team?.id;

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

        if (!channel || !threadTs) {
          const fromAttachment = extractThreadFromIssue(issue);
          if (fromAttachment) {
            channel = channel ?? fromAttachment.channel;
            threadTs = threadTs ?? fromAttachment.ts;
            messageUrl = messageUrl ?? fromAttachment.permalink;
          }
        }

        if (!channel || !threadTs) {
          const stored = await getThreadEntry(linearThreadScope(teamId), issueId);
          if (stored?.permalink) {
            const parsed = parseMessageUrl(stored.permalink);
            if (parsed) {
              channel = channel ?? parsed.channel;
              threadTs = threadTs ?? parsed.ts;
              messageUrl = messageUrl ?? stored.permalink;
            }
          }
          if (stored?.channel && stored?.ts) {
            channel = channel ?? stored.channel;
            threadTs = threadTs ?? stored.ts;
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

          await createThreadAttachment(linear, issue.id, permalink, channel, rootTs);

          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink,
            channel,
            ts: rootTs
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

        if (messageUrl) {
          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink: messageUrl,
            channel,
            ts: threadTs
          });
        }

        outputJson(result);
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

        if ((!channel || !threadTs) && messageUrl) {
          const parsed = parseMessageUrl(messageUrl);
          if (parsed) {
            channel = channel ?? parsed.channel;
            threadTs = threadTs ?? parsed.ts;
          }
        }

        if (!channel || !threadTs) {
          const fromAttachment = extractThreadFromIssue(issue);
          if (fromAttachment) {
            channel = channel ?? fromAttachment.channel;
            threadTs = threadTs ?? fromAttachment.ts;
            messageUrl = messageUrl ?? fromAttachment.permalink;
          }
        }

        if (!channel || !threadTs) {
          const stored = await getThreadEntry(linearThreadScope(teamId), issueId);
          if (stored?.permalink) {
            const parsed = parseMessageUrl(stored.permalink);
            if (parsed) {
              channel = channel ?? parsed.channel;
              threadTs = threadTs ?? parsed.ts;
            }
          }
          if (stored?.channel && stored?.ts) {
            channel = channel ?? stored.channel;
            threadTs = threadTs ?? stored.ts;
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

        if (messageUrl && channel && threadTs) {
          await setThreadEntry(linearThreadScope(teamId), issueId, {
            permalink: messageUrl,
            channel,
            ts: threadTs
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
    states?: { nodes?: Array<Record<string, unknown>> };
  };
};

type LinearIssue = {
  id: string;
  identifier?: string;
  title?: string;
  team?: { id?: string; name?: string };
  attachments?: { nodes?: Array<{ url?: string }> };
};

function getLinearClient(): LinearClient {
  const apiKey = resolveLinearApiKey();
  if (!apiKey) {
    throw new Error("Missing Linear API key. Set LINEAR_API_KEY or .ml-agent.config.json");
  }
  return new LinearClient(apiKey);
}

function resolveTeamId(option?: string): string {
  const teamId = option ?? resolveLinearTeamId();
  if (!teamId) {
    throw new Error("Provide --team or set LINEAR_TEAM_ID / .ml-agent.config.json");
  }
  return teamId;
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

function extractThreadFromIssue(issue: LinearIssue): { permalink?: string; channel: string; ts: string } | null {
  const attachments = issue.attachments?.nodes ?? [];
  for (const attachment of attachments) {
    if (!attachment?.url) {
      continue;
    }
    if (!attachment.url.includes("slack.com/archives/")) {
      continue;
    }
    const parsed = parseMessageUrl(attachment.url);
    if (parsed) {
      return { permalink: attachment.url, channel: parsed.channel, ts: parsed.ts };
    }
  }
  return null;
}

function buildLinearThreadRootText(issue: LinearIssue): string {
  const identifier = issue.identifier ? `${issue.identifier}` : "issue";
  const title = issue.title ? `: ${issue.title}` : "";
  return `Thread for Linear ${identifier}${title}`;
}

async function createThreadAttachment(
  client: LinearClient,
  issueId: string,
  permalink: string,
  channel: string,
  threadTs: string
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
          thread_ts: threadTs
        }
      }
    });
  } catch {
    // Best effort; attachment is optional if the org disallows it
  }
}
