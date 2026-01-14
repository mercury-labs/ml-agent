import { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";

import {
  resolveLinearApiKey,
  resolveLinearStateSync,
  resolveLinearTeamId,
  resolveLinearTeamKey,
  resolveProjectConfigTargetPath
} from "../lib/config";
import { LinearClient } from "../lib/linear-client";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

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
        }
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

type CycleNode = {
  id?: string;
  name?: string;
  number?: number;
  startsAt?: string;
  endsAt?: string;
};

type TeamCyclesResponse = {
  team?: {
    id?: string;
    name?: string;
    cycles?: { nodes?: CycleNode[] };
  };
};

type TeamStatesResponse = {
  team?: {
    id?: string;
    name?: string;
    states?: { nodes?: Array<{ id?: string; name?: string; type?: string }> };
  };
};

type TeamsResponse = {
  teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
};

export function registerSyncCommand(program: Command): void {
  const sync = program.command("sync").description("Sync helper commands");

  sync
    .command("cycles")
    .description("Fetch the latest Linear cycles (optionally update config)")
    .option("--team <team-id>", "Team ID (defaults to LINEAR_TEAM_ID)")
    .option("--team-key <key>", "Team key to resolve (e.g. PRO)")
    .option("--limit <count>", "Maximum cycles to return", "15")
    .option("--current", "Return only the current cycle", false)
    .option("--write", "Update .ml-agent.config.json with current cycle id", false)
    .option("--write-team", "Update .ml-agent.config.json with resolved team id", false)
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const apiKey = resolveLinearApiKey();
        if (!apiKey) {
          throw new Error("Missing Linear API key. Set LINEAR_API_KEY or .ml-agent.config.json");
        }
        const client = new LinearClient(apiKey);
        const resolvedTeamId = await resolveTeamId(
          client,
          options.team as string | undefined,
          options.teamKey as string | undefined
        );
        if (!resolvedTeamId) {
          throw new Error(
            "Provide --team/--team-key or set LINEAR_TEAM_ID / LINEAR_TEAM_KEY / .ml-agent.config.json"
          );
        }

        const limit = parseLimit(options.limit);
        const result = await client.request<TeamCyclesResponse>(TEAM_CYCLES_QUERY, {
          teamId: resolvedTeamId,
          first: limit
        });

        const cycles = (result.team?.cycles?.nodes ?? []).filter(Boolean);
        const current = findCurrentCycle(cycles);
        const cyclesEnabled = cycles.length > 0;

        let updatedConfigPath: string | null = null;
        let stateMapResult: { written: boolean; map: Record<string, string> } | null = null;
        if (options.writeTeam) {
          updatedConfigPath = await updateTeamInConfig(resolvedTeamId);
        }
        if (resolveLinearStateSync()) {
          stateMapResult = await maybeWriteStateMap(client, resolvedTeamId);
          if (stateMapResult.written) {
            updatedConfigPath = resolveProjectConfigTargetPath();
          }
        }
        if (options.write) {
          if (!current?.id) {
            const message = cyclesEnabled
              ? "No current cycle found to write."
              : "No cycles found for this team (cycles may be disabled).";
            const payload = {
              ok: false,
              team_id: resolvedTeamId,
              current_cycle: null,
              cycles,
              cycles_enabled: cyclesEnabled,
              state_map: stateMapResult?.map ?? null,
              state_map_written: stateMapResult?.written ?? false,
              updated_config_path: updatedConfigPath,
              message
            };
            if (options.current) {
              outputJson(payload);
              return;
            }
            outputJson(payload);
            return;
          }
          updatedConfigPath = await updateCycleInConfig(current.id);
        }

        if (options.current) {
          outputJson({
          ok: Boolean(current),
          team_id: resolvedTeamId,
          current_cycle: current ?? null,
          cycles_enabled: cyclesEnabled,
          state_map: stateMapResult?.map ?? null,
          state_map_written: stateMapResult?.written ?? false,
          updated_config_path: updatedConfigPath
        });
        return;
      }

      outputJson({
        ok: true,
        team_id: resolvedTeamId,
        current_cycle: current ?? null,
        cycles,
        cycles_enabled: cyclesEnabled,
        state_map: stateMapResult?.map ?? null,
        state_map_written: stateMapResult?.written ?? false,
        updated_config_path: updatedConfigPath
      });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? 15);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return limit;
}

function findCurrentCycle(cycles: CycleNode[]): CycleNode | null {
  const now = new Date();
  for (const cycle of cycles) {
    if (!cycle?.startsAt || !cycle?.endsAt) {
      continue;
    }
    const start = new Date(cycle.startsAt);
    const end = new Date(cycle.endsAt);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf())) {
      if (start <= now && now <= end) {
        return cycle;
      }
    }
  }
  return null;
}

async function updateCycleInConfig(cycleId: string): Promise<string> {
  const configPath = resolveProjectConfigTargetPath();
  let config: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const linear = (config.linear ?? {}) as Record<string, unknown>;
  linear.cycle_id = cycleId;
  config.linear = linear;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

async function updateTeamInConfig(teamId: string): Promise<string> {
  const configPath = resolveProjectConfigTargetPath();
  let config: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const linear = (config.linear ?? {}) as Record<string, unknown>;
  linear.team_id = teamId;
  config.linear = linear;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

async function maybeWriteStateMap(
  client: LinearClient,
  teamId: string
): Promise<{ written: boolean; map: Record<string, string> }> {
  const stateMap = await inferStateMap(client, teamId);
  if (Object.keys(stateMap).length === 0) {
    return { written: false, map: stateMap };
  }

  const configPath = resolveProjectConfigTargetPath();
  let config: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const linear = (config.linear ?? {}) as Record<string, unknown>;
  const existing = linear.state_map;
  if (existing && typeof existing === "object" && Object.keys(existing as Record<string, unknown>).length > 0) {
    return { written: false, map: stateMap };
  }

  linear.state_map = stateMap;
  config.linear = linear;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { written: true, map: stateMap };
}

async function inferStateMap(
  client: LinearClient,
  teamId: string
): Promise<Record<string, string>> {
  const result = await client.request<TeamStatesResponse>(TEAM_STATES_QUERY, { teamId });
  const states = result.team?.states?.nodes ?? [];
  if (states.length === 0) {
    return {};
  }

  const map: Record<string, string> = {};
  const waiting = findStateByName(states, [
    /needs input/i,
    /waiting/i,
    /awaiting/i,
    /pending/i
  ]);
  const blocked = findStateByName(states, [/blocked/i]);
  const ready = findStateByName(states, [/in progress/i, /doing/i, /implement/i, /development/i]) ?? findStateByType(states, "started");
  const done = findStateByName(states, [/done/i, /completed/i, /shipped/i, /released/i]) ?? findStateByType(states, "completed");

  if (waiting) {
    map.waiting_on_user = waiting.name!;
  }
  if (blocked) {
    map.blocked = blocked.name!;
  }
  if (ready) {
    map.ready_to_implement = ready.name!;
  }
  if (done) {
    map.done = done.name!;
  }

  return map;
}

function findStateByName(
  states: Array<{ name?: string; type?: string }>,
  patterns: RegExp[]
): { name?: string; type?: string } | undefined {
  for (const state of states) {
    const name = state.name;
    if (!name) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(name))) {
      return state;
    }
  }
  return undefined;
}

function findStateByType(
  states: Array<{ name?: string; type?: string }>,
  type: string
): { name?: string; type?: string } | undefined {
  return states.find((state) => state.type === type);
}

async function resolveTeamId(
  client: LinearClient,
  explicitId?: string,
  teamKey?: string
): Promise<string | null> {
  if (explicitId) {
    if (looksLikeId(explicitId)) {
      return explicitId;
    }
    teamKey = explicitId;
  }
  const configured = resolveLinearTeamId();
  if (configured) {
    if (looksLikeId(configured)) {
      return configured;
    }
    if (!teamKey) {
      teamKey = configured;
    }
  }
  const configuredKey = resolveLinearTeamKey();
  if (!teamKey && configuredKey) {
    teamKey = configuredKey;
  }
  if (!teamKey) {
    return null;
  }
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

function looksLikeId(value: string): boolean {
  return /^[0-9a-f-]{32,36}$/i.test(value);
}
