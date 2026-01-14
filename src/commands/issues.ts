import { Command } from "commander";

import {
  resolveLinearApiKey,
  resolveLinearCycleId,
  resolveLinearTeamId,
  resolveLinearTeamKey
} from "../lib/config";
import { LinearClient } from "../lib/linear-client";
import { getThreadEntry } from "../lib/thread-map";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

const TEAM_ISSUES_QUERY = `
  query TeamIssues($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      id
      name
      issues(first: $first, after: $after, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          url
          state { id name type }
          assignee { id name email }
          cycle { id name }
          updatedAt
          createdAt
        }
        pageInfo {
          hasNextPage
          endCursor
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
      team { id name }
      state { id name type }
      assignee { id name email }
      cycle { id name }
      updatedAt
      createdAt
    }
  }
`;

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
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
        identifier
        title
        url
      }
    }
  }
`;

const ISSUE_COMMENTS_QUERY = `
  query IssueComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      id
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user {
            id
            name
            displayName
            email
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        url
      }
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

const USERS_QUERY = `
  query Users($first: Int!) {
    users(first: $first) {
      nodes {
        id
        name
        displayName
        email
      }
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

type IssueNode = {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  team?: { id?: string; name?: string };
  state?: { id?: string; name?: string; type?: string };
  assignee?: { id?: string; name?: string; email?: string };
  cycle?: { id?: string; name?: string };
  updatedAt?: string;
  createdAt?: string;
};

type TeamIssuesResponse = {
  team?: {
    id?: string;
    name?: string;
    issues?: {
      nodes?: IssueNode[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string };
    };
  };
};

type TeamStatesResponse = {
  team?: {
    id?: string;
    name?: string;
    states?: { nodes?: Array<{ id?: string; name?: string; type?: string }> };
  };
};

type UsersResponse = {
  users?: { nodes?: Array<{ id?: string; name?: string; displayName?: string; email?: string }> };
};

type TeamsResponse = {
  teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
};

type CommentNode = {
  id?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  user?: { id?: string; name?: string; displayName?: string; email?: string };
};

type IssueCommentsPageInfo = {
  hasNextPage?: boolean;
  endCursor?: string;
};

type IssueCommentsResponse = {
  issue?: {
    id?: string;
    comments?: {
      nodes?: CommentNode[];
      pageInfo?: IssueCommentsPageInfo;
    };
  };
};

export function registerIssuesCommands(program: Command): void {
  const issues = program.command("issues").description("Linear issue operations");

  issues
    .command("list")
    .description("List issues for a team")
    .option("--team <team-id>", "Team ID (defaults to LINEAR_TEAM_ID)")
    .option("--cycle <cycle-id>", "Cycle ID (defaults to LINEAR_CYCLE_ID)")
    .option("--state <state>", "State name or ID")
    .option("--assignee <assignee>", "Assignee email/name/ID")
    .option("--limit <count>", "Maximum issues to return", "50")
    .option("--compact", "Return only id/identifier/title/state", false)
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const teamId = await resolveTeamId(client, options.team);
        const cycleId = resolveCycleId(options.cycle);
        const limit = parseLimit(options.limit);

        const collected: IssueNode[] = [];
        let cursor: string | undefined = undefined;

        while (collected.length < limit) {
          const batchSize = Math.min(50, limit);
          const result: TeamIssuesResponse = await client.request<TeamIssuesResponse>(TEAM_ISSUES_QUERY, {
            teamId,
            first: batchSize,
            after: cursor
          });

          const nodes: IssueNode[] = result.team?.issues?.nodes ?? [];
          const filtered = nodes.filter((issue: IssueNode) =>
            matchesFilters(issue, {
              state: options.state as string | undefined,
              assignee: options.assignee as string | undefined,
              cycle: cycleId ?? (options.cycle as string | undefined)
            })
          );

          collected.push(...filtered);

          const pageInfo = result.team?.issues?.pageInfo;
          if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
            break;
          }
          cursor = pageInfo.endCursor;
        }

        const trimmed = collected.slice(0, limit);
        const threadScope = linearThreadScope(teamId);
        const latestThreads = options.compact
          ? await Promise.all(trimmed.map((issue) => getThreadEntry(threadScope, issue.id)))
          : [];

        const payload = options.compact
          ? trimmed.map((issue, index) => {
              const thread = latestThreads[index] ?? null;
              return {
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                state: issue.state?.name,
                assignee: issue.assignee?.email ?? issue.assignee?.name,
                cycle: issue.cycle?.name,
                thread_state: thread?.state ?? null,
                latest_thread: thread
                  ? {
                      permalink: thread.permalink,
                      channel: thread.channel,
                      ts: thread.ts,
                      label: thread.label,
                      state: thread.state
                    }
                  : null
              };
            })
          : trimmed;

        outputJson({
          ok: true,
          team_id: teamId,
          issue_count: trimmed.length,
          issues: payload
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("get")
    .description("Get issue details")
    .argument("<issue-id>", "Issue ID or identifier")
    .action(async (issueId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const result = await client.request<{ issue?: IssueNode }>(ISSUE_QUERY, { id: issueId });
        if (!result.issue) {
          throw new Error("Issue not found");
        }
        outputJson({ ok: true, issue: result.issue });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("comments")
    .description("List comments for a Linear issue")
    .argument("<issue-id>", "Issue ID or identifier")
    .option("--limit <count>", "Maximum comments to return", "100")
    .option("--compact", "Return only id/body/author/timestamps", false)
    .action(async (issueId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const limit = parseLimit(options.limit, 100);
        const result = await fetchIssueComments(client, issueId, limit);
        const comments = result.comments;

        const payload = options.compact
          ? comments.map((comment) => ({
              id: comment.id,
              author: comment.user?.displayName ?? comment.user?.name ?? comment.user?.email ?? null,
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              body: comment.body
            }))
          : comments;

        outputJson({
          ok: true,
          issue_id: issueId,
          comment_count: comments.length,
          comments_truncated: result.hasNextPage,
          comments: payload
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("comment")
    .description("Post a comment on a Linear issue (Markdown supported)")
    .argument("<issue-id>", "Issue ID or identifier")
    .argument("<text>", "Comment text (Markdown)")
    .action(async (issueId: string, text: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const result = await client.request<Record<string, unknown>>(COMMENT_CREATE_MUTATION, {
          input: {
            issueId,
            body: text
          }
        });
        outputJson({ ok: true, result });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("attach")
    .description("Attach a URL to a Linear issue")
    .argument("<issue-id>", "Issue ID or identifier")
    .argument("<url>", "URL to attach")
    .option("--title <text>", "Title for the attachment")
    .option("--metadata <json>", "Optional JSON metadata for the attachment")
    .action(async (issueId: string, url: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const metadata = parseMetadata(options.metadata as string | undefined);
        const input: Record<string, unknown> = {
          issueId,
          url,
          title: options.title ?? url,
          metadata: {
            source: "ml-agent",
            ...metadata
          }
        };

        const result = await client.request<Record<string, unknown>>(ATTACHMENT_CREATE_MUTATION, { input });
        outputJson({ ok: true, result });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("status")
    .description("Summarize issue state + thread state + last comment")
    .argument("<issue-id>", "Issue ID or identifier")
    .option("--comment-limit <count>", "Maximum comments to scan for last activity", "50")
    .action(async (issueId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const issue = await fetchIssue(client, issueId);
        const teamId = await resolveTeamId(client, issue.team?.id);
        const thread = await getThreadEntry(linearThreadScope(teamId), issue.id);

        const commentLimit = parseLimit(options.commentLimit, 50);
        const commentsResult = await fetchIssueComments(client, issueId, commentLimit);
        const lastCommentAt = findLatestCommentTimestamp(commentsResult.comments);

        outputJson({
          ok: true,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            state: issue.state?.name,
            state_id: issue.state?.id,
            assignee: issue.assignee?.email ?? issue.assignee?.name ?? null,
            updated_at: issue.updatedAt
          },
          thread_state: thread?.state ?? null,
          thread_label: thread?.label ?? null,
          latest_thread: thread ?? null,
          last_comment_at: lastCommentAt,
          comments_truncated: commentsResult.hasNextPage
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("create")
    .description("Create a new issue")
    .option("--team <team-id>", "Team ID (defaults to LINEAR_TEAM_ID)")
    .option("--title <title>", "Issue title")
    .option("--description <text>", "Issue description")
    .option("--state <state>", "State name or ID")
    .option("--assignee <assignee>", "Assignee email/name/ID")
    .option("--cycle <cycle-id>", "Cycle ID (defaults to LINEAR_CYCLE_ID)")
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const teamId = await resolveTeamId(client, options.team);
        const title = options.title as string | undefined;
        if (!title) {
          throw new Error("--title is required");
        }

        const stateId = await resolveStateId(client, teamId, options.state as string | undefined);
        const assigneeId = await resolveAssigneeId(client, options.assignee as string | undefined);
        const cycleId = resolveCycleId(options.cycle);

        const input: Record<string, unknown> = {
          teamId,
          title
        };
        if (options.description) {
          input.description = options.description;
        }
        if (stateId) {
          input.stateId = stateId;
        }
        if (assigneeId) {
          input.assigneeId = assigneeId;
        }
        if (cycleId) {
          input.cycleId = cycleId;
        }

        const result = await client.request<{ issueCreate?: Record<string, unknown> }>(
          ISSUE_CREATE_MUTATION,
          { input }
        );
        outputJson({ ok: true, result });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  issues
    .command("update")
    .description("Update issue fields")
    .argument("<issue-id>", "Issue ID or identifier")
    .option("--title <title>", "Issue title")
    .option("--description <text>", "Issue description")
    .option("--state <state>", "State name or ID")
    .option("--assignee <assignee>", "Assignee email/name/ID")
    .option("--cycle <cycle-id>", "Cycle ID (defaults to LINEAR_CYCLE_ID)")
    .option("--team <team-id>", "Team ID (defaults to LINEAR_TEAM_ID)")
    .action(async (issueId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const client = getLinearClient();
        const teamId = await resolveTeamId(client, options.team);

        const stateId = await resolveStateId(client, teamId, options.state as string | undefined);
        const assigneeId = await resolveAssigneeId(client, options.assignee as string | undefined);
        const cycleId = resolveCycleId(options.cycle);

        const input: Record<string, unknown> = {};
        if (options.title) {
          input.title = options.title;
        }
        if (options.description) {
          input.description = options.description;
        }
        if (stateId) {
          input.stateId = stateId;
        }
        if (assigneeId) {
          input.assigneeId = assigneeId;
        }
        if (cycleId) {
          input.cycleId = cycleId;
        }

        if (Object.keys(input).length === 0) {
          throw new Error("No updates provided");
        }

        const result = await client.request<{ issueUpdate?: Record<string, unknown> }>(
          ISSUE_UPDATE_MUTATION,
          { id: issueId, input }
        );
        outputJson({ ok: true, result });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

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

function resolveCycleId(option?: string): string | undefined {
  return option ?? resolveLinearCycleId();
}

function parseLimit(value: string | undefined, fallback = 50): number {
  const limit = Number(value ?? fallback);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return limit;
}

function matchesFilters(
  issue: IssueNode,
  filters: { state?: string; assignee?: string; cycle?: string }
): boolean {
  if (filters.state) {
    const normalized = filters.state.toLowerCase();
    const stateName = issue.state?.name?.toLowerCase();
    if (issue.state?.id !== filters.state && stateName !== normalized) {
      return false;
    }
  }

  if (filters.assignee) {
    const normalized = filters.assignee.toLowerCase();
    const idMatch = issue.assignee?.id === filters.assignee;
    const emailMatch = issue.assignee?.email?.toLowerCase() === normalized;
    const nameMatch = issue.assignee?.name?.toLowerCase() === normalized;
    if (!idMatch && !emailMatch && !nameMatch) {
      return false;
    }
  }

  if (filters.cycle) {
    const normalized = filters.cycle.toLowerCase();
    const cycleName = issue.cycle?.name?.toLowerCase();
    if (issue.cycle?.id !== filters.cycle && cycleName !== normalized) {
      return false;
    }
  }

  return true;
}

async function resolveStateId(
  client: LinearClient,
  teamId: string,
  input?: string
): Promise<string | undefined> {
  if (!input) {
    return undefined;
  }
  if (looksLikeId(input)) {
    return input;
  }

  const result = await client.request<TeamStatesResponse>(TEAM_STATES_QUERY, { teamId });
  const states = result.team?.states?.nodes ?? [];
  const normalized = input.toLowerCase();
  const match = states.find((state) => state.name?.toLowerCase() === normalized);
  if (!match?.id) {
    throw new Error(`Unknown state: ${input}`);
  }
  return match.id;
}

async function resolveAssigneeId(client: LinearClient, input?: string): Promise<string | undefined> {
  if (!input) {
    return undefined;
  }
  if (looksLikeId(input)) {
    return input;
  }

  const result = await client.request<UsersResponse>(USERS_QUERY, { first: 200 });
  const users = result.users?.nodes ?? [];
  const normalized = input.toLowerCase();
  const match = users.find((user) => {
    if (user.email && user.email.toLowerCase() === normalized) {
      return true;
    }
    if (user.name && user.name.toLowerCase() === normalized) {
      return true;
    }
    if (user.displayName && user.displayName.toLowerCase() === normalized) {
      return true;
    }
    return false;
  });

  if (!match?.id) {
    throw new Error(`Unable to resolve assignee: ${input}`);
  }
  return match.id;
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f-]{32,36}$/i.test(value);
}

async function resolveTeamIdByKey(client: LinearClient, teamKey: string): Promise<string | null> {
  const result = await client.request<TeamsResponse>(TEAMS_QUERY);
  const teams = result.teams?.nodes ?? [];
  const normalized = teamKey.toLowerCase();
  const match = teams.find(
    (team) =>
      (team.key && team.key.toLowerCase() === normalized) ||
      (team.name && team.name.toLowerCase() === normalized)
  );
  return match?.id ?? null;
}

async function fetchIssue(client: LinearClient, issueId: string): Promise<IssueNode> {
  const result = await client.request<{ issue?: IssueNode }>(ISSUE_QUERY, { id: issueId });
  if (!result.issue) {
    throw new Error("Issue not found");
  }
  return result.issue;
}

async function fetchIssueComments(
  client: LinearClient,
  issueId: string,
  limit: number
): Promise<{ comments: CommentNode[]; hasNextPage: boolean }> {
  const comments: CommentNode[] = [];
  let cursor: string | undefined = undefined;
  let hasNextPage = false;

  while (comments.length < limit) {
    const batchSize = Math.min(50, limit - comments.length);
    const result: IssueCommentsResponse = await client.request<IssueCommentsResponse>(ISSUE_COMMENTS_QUERY, {
      id: issueId,
      first: batchSize,
      after: cursor
    });

    const page = result.issue?.comments?.nodes ?? [];
    comments.push(...page);

    const pageInfo: IssueCommentsPageInfo | undefined = result.issue?.comments?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
      hasNextPage = false;
      break;
    }
    cursor = pageInfo.endCursor;
    hasNextPage = true;
  }

  return {
    comments: comments.slice(0, limit),
    hasNextPage
  };
}

function findLatestCommentTimestamp(comments: CommentNode[]): string | null {
  let latestTime = 0;
  let latestValue: string | null = null;
  for (const comment of comments) {
    const candidate = comment.updatedAt ?? comment.createdAt;
    if (!candidate) {
      continue;
    }
    const time = Date.parse(candidate);
    if (Number.isNaN(time)) {
      continue;
    }
    if (time >= latestTime) {
      latestTime = time;
      latestValue = candidate;
    }
  }
  return latestValue;
}

function parseMetadata(value?: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("--metadata must be valid JSON");
  }
}

function linearThreadScope(teamId: string): string {
  return teamId ? `linear:${teamId}` : "linear";
}
