import { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";

import {
  resolveLinearApiKey,
  resolveLinearTeamId,
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

export function registerSyncCommand(program: Command): void {
  const sync = program.command("sync").description("Sync helper commands");

  sync
    .command("cycles")
    .description("Fetch the latest Linear cycles (optionally update config)")
    .option("--team <team-id>", "Team ID (defaults to LINEAR_TEAM_ID)")
    .option("--limit <count>", "Maximum cycles to return", "15")
    .option("--current", "Return only the current cycle", false)
    .option("--write", "Update .ml-agent.config.json with current cycle id", false)
    .action(async (options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const apiKey = resolveLinearApiKey();
        if (!apiKey) {
          throw new Error("Missing Linear API key. Set LINEAR_API_KEY or .ml-agent.config.json");
        }
        const teamId = options.team ?? resolveLinearTeamId();
        if (!teamId) {
          throw new Error("Provide --team or set LINEAR_TEAM_ID / .ml-agent.config.json");
        }

        const limit = parseLimit(options.limit);
        const client = new LinearClient(apiKey);
        const result = await client.request<TeamCyclesResponse>(TEAM_CYCLES_QUERY, {
          teamId,
          first: limit
        });

        const cycles = (result.team?.cycles?.nodes ?? []).filter(Boolean);
        const current = findCurrentCycle(cycles);

        let updatedConfigPath: string | null = null;
        if (options.write) {
          if (!current?.id) {
            throw new Error("No current cycle found to write.");
          }
          updatedConfigPath = await updateCycleInConfig(current.id);
        }

        if (options.current) {
          outputJson({
            ok: Boolean(current),
            team_id: teamId,
            current_cycle: current ?? null,
            updated_config_path: updatedConfigPath
          });
          return;
        }

        outputJson({
          ok: true,
          team_id: teamId,
          current_cycle: current ?? null,
          cycles,
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
