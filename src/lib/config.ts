export type TokenOptions = {
  token?: string;
  asUser?: boolean;
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

export function resolveDefaultChannel(): string | undefined {
  return process.env.SLACK_LIST_DEFAULT_CHANNEL;
}
