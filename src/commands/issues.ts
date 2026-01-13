import { Command } from "commander";

import { resolveLinearApiKey, resolveLinearCycleId, resolveLinearTeamId } from "../lib/config";
import { LinearClient } from "../lib/linear-client";
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

type IssueNode = {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
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
        const teamId = resolveTeamId(options.team);
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
        const payload = options.compact
          ? trimmed.map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              state: issue.state?.name,
              assignee: issue.assignee?.email ?? issue.assignee?.name,
              cycle: issue.cycle?.name
            }))
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
        const teamId = resolveTeamId(options.team);
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
        const teamId = resolveTeamId(options.team);

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

function resolveTeamId(option?: string): string {
  const teamId = option ?? resolveLinearTeamId();
  if (!teamId) {
    throw new Error("Provide --team or set LINEAR_TEAM_ID / .ml-agent.config.json");
  }
  return teamId;
}

function resolveCycleId(option?: string): string | undefined {
  return option ?? resolveLinearCycleId();
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? 50);
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
