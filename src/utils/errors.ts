import { outputError, formatError, formatSlackError, ErrorDetails } from "./output";

export function handleCommandError(error: unknown, verbose?: boolean): never {
  const base = verbose ? formatSlackError(error) : formatError(error);
  const slackCode = extractSlackErrorCode(error);
  const hint = slackCode ? hintForSlackError(slackCode, error) : undefined;
  const details: ErrorDetails = {
    ...base,
    code: slackCode,
    hint
  };
  outputError("command_failed", details);
}

function extractSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("data" in error) {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) {
      return data.error;
    }
  }
  return undefined;
}

function hintForSlackError(code: string, error: unknown): string | undefined {
  switch (code) {
    case "list_not_found":
      return "Verify the list ID (F...), share the list to a channel the bot can access, run `ml-agent access set`, or use `--as-user` with a user token.";
    case "not_in_channel":
      return "Invite the bot to the channel or grant list access via `ml-agent access set`.";
    case "missing_scope": {
      const needed = (error as { data?: { needed?: string } })?.data?.needed;
      return needed
        ? `Missing OAuth scopes: ${needed}. Reinstall the app after updating the manifest.`
        : "Missing OAuth scopes. Update the app scopes and reinstall.";
    }
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
      return "Check that SLACK_TOKEN / SLACK_USER_TOKEN is valid and has access to the workspace.";
    case "ratelimited":
    case "rate_limited":
      return "Slack rate limit hit. The CLI will retry automatically, but you may need to slow down calls.";
    default:
      return undefined;
  }
}
