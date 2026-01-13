import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";

export type TokenOptions = {
  token?: string;
  asUser?: boolean;
};

type CliConfig = {
  default_channel?: string;
  lists?: Record<string, { channel?: string }>;
};

let cachedConfig: CliConfig | null | undefined;
let cachedProjectConfig: ProjectConfig | null | undefined;

type ProjectConfig = {
  slack?: {
    default_channel?: string;
  };
  linear?: {
    api_key?: string;
    team_id?: string;
    cycle_id?: string;
  };
};

export function resolveToken(options: TokenOptions = {}): string {
  if (options.token) {
    return options.token;
  }

  if (options.asUser) {
    const userToken = process.env.SLACK_USER_TOKEN ?? process.env.SLACK_TOKEN;
    if (userToken) {
      return userToken;
    }
  }

  const token =
    process.env.SLACK_TOKEN ??
    process.env.SLACK_BOT_TOKEN ??
    process.env.SLACK_USER_TOKEN;

  if (!token) {
    throw new Error(
      "No Slack token found. Set SLACK_TOKEN or SLACK_BOT_TOKEN (or SLACK_USER_TOKEN with --as-user)."
    );
  }

  return token;
}

export function resolveSchemaPath(cliPath?: string): string | undefined {
  return cliPath ?? process.env.SLACK_LIST_SCHEMA_PATH;
}

export function resolveDefaultChannel(listId?: string): string | undefined {
  if (process.env.SLACK_LIST_DEFAULT_CHANNEL) {
    return process.env.SLACK_LIST_DEFAULT_CHANNEL;
  }

  const project = loadProjectConfig();
  if (project?.slack?.default_channel) {
    return project.slack.default_channel;
  }

  const config = loadConfig();
  if (listId && config?.lists?.[listId]?.channel) {
    return config.lists[listId]?.channel;
  }

  return config?.default_channel;
}

export function resolveLinearApiKey(): string | undefined {
  if (process.env.LINEAR_API_KEY) {
    return process.env.LINEAR_API_KEY;
  }
  const project = loadProjectConfig();
  return project?.linear?.api_key;
}

export function resolveLinearTeamId(): string | undefined {
  if (process.env.LINEAR_TEAM_ID) {
    return process.env.LINEAR_TEAM_ID;
  }
  const project = loadProjectConfig();
  return project?.linear?.team_id;
}

export function resolveLinearCycleId(): string | undefined {
  if (process.env.LINEAR_CYCLE_ID) {
    return process.env.LINEAR_CYCLE_ID;
  }
  const project = loadProjectConfig();
  return project?.linear?.cycle_id;
}

export function resolveThreadMapPath(): string {
  if (process.env.ML_AGENT_THREAD_MAP_PATH) {
    return process.env.ML_AGENT_THREAD_MAP_PATH;
  }
  if (process.env.SLACK_LIST_THREAD_MAP_PATH) {
    return process.env.SLACK_LIST_THREAD_MAP_PATH;
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ml-agent", "threads.json");
}

function loadConfig(): CliConfig | null {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const filePath = resolveConfigPath();
  if (!filePath) {
    cachedConfig = null;
    return cachedConfig;
  }

  try {
    const contents = readFileSync(filePath, "utf-8");
    cachedConfig = JSON.parse(contents) as CliConfig;
    return cachedConfig;
  } catch (error) {
    cachedConfig = null;
    return cachedConfig;
  }
}

function resolveConfigPath(): string | null {
  if (process.env.ML_AGENT_CONFIG_PATH) {
    return process.env.ML_AGENT_CONFIG_PATH;
  }
  if (process.env.SLACK_LIST_CONFIG_PATH) {
    return process.env.SLACK_LIST_CONFIG_PATH;
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const primary = path.join(base, "ml-agent", "config.json");
  const legacy = path.join(base, "slack-lists-cli", "config.json");
  if (existsSync(primary)) {
    return primary;
  }
  if (existsSync(legacy)) {
    return legacy;
  }
  return primary;
}

function loadProjectConfig(): ProjectConfig | null {
  if (cachedProjectConfig !== undefined) {
    return cachedProjectConfig;
  }

  const filePath = findProjectConfigPath();
  if (!filePath) {
    cachedProjectConfig = null;
    return cachedProjectConfig;
  }

  try {
    const contents = readFileSync(filePath, "utf-8");
    cachedProjectConfig = JSON.parse(contents) as ProjectConfig;
    return cachedProjectConfig;
  } catch {
    cachedProjectConfig = null;
    return cachedProjectConfig;
  }
}

function findProjectConfigPath(): string | null {
  const filenames = [".ml-agent.config.json", ".slack-lists.config.json"];
  let current = process.cwd();
  while (true) {
    for (const filename of filenames) {
      const candidate = path.join(current, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}
