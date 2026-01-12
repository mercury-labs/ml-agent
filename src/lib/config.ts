import { readFileSync } from "fs";
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

  const config = loadConfig();
  if (listId && config?.lists?.[listId]?.channel) {
    return config.lists[listId]?.channel;
  }

  return config?.default_channel;
}

export function resolveThreadMapPath(): string {
  if (process.env.SLACK_LIST_THREAD_MAP_PATH) {
    return process.env.SLACK_LIST_THREAD_MAP_PATH;
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "slack-lists-cli", "threads.json");
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
  if (process.env.SLACK_LIST_CONFIG_PATH) {
    return process.env.SLACK_LIST_CONFIG_PATH;
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "slack-lists-cli", "config.json");
}
