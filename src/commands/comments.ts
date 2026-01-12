import { Command } from "commander";

import { resolveToken } from "../lib/config";
import { parseMessageUrl, resolveChannelId, resolveUserId } from "../lib/resolvers";
import { SlackListsClient } from "../lib/slack-client";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

export function registerCommentCommands(program: Command): void {
  program
    .command("comment")
    .description("Post a comment on a list item thread")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .argument("<text>", "Comment text")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--message-url <url>", "Slack message URL to infer thread")
    .action(async (listId: string, itemId: string, text: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        let channel = options.channel ? await resolveChannelId(client, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;

        if (!channel || !threadTs) {
          const messageUrl = options.messageUrl as string | undefined;
          if (messageUrl) {
            const parsed = parseMessageUrl(messageUrl);
            if (parsed) {
              channel = channel ?? parsed.channel;
              threadTs = threadTs ?? parsed.ts;
            }
          }
        }

        if (!channel || !threadTs) {
          const itemResult = await client.call("slackLists.items.info", {
            list_id: listId,
            id: itemId
          });
          const thread = extractThreadFromItem(itemResult as unknown as Record<string, unknown>);
          if (thread) {
            channel = channel ?? thread.channel;
            threadTs = threadTs ?? thread.ts;
          }
        }

        if (!channel || !threadTs) {
          throw new Error(
            "Unable to infer thread. Provide --channel and --thread-ts or --message-url."
          );
        }

        const result = await client.postMessage({
          channel,
          text,
          thread_ts: threadTs
        });

        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  program
    .command("comments")
    .description("List comment thread for a list item")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--message-url <url>", "Slack message URL to infer thread")
    .option("--limit <count>", "Maximum messages to return", "200")
    .option("--compact", "Return only user/text/ts fields", false)
    .action(async (listId: string, itemId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        let channel = options.channel ? await resolveChannelId(client, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;

        if (!channel || !threadTs) {
          const messageUrl = options.messageUrl as string | undefined;
          if (messageUrl) {
            const parsed = parseMessageUrl(messageUrl);
            if (parsed) {
              channel = channel ?? parsed.channel;
              threadTs = threadTs ?? parsed.ts;
            }
          }
        }

        if (!channel || !threadTs) {
          const itemResult = await client.call("slackLists.items.info", {
            list_id: listId,
            id: itemId
          });
          const thread = extractThreadFromItem(itemResult as unknown as Record<string, unknown>);
          if (thread) {
            channel = channel ?? thread.channel;
            threadTs = threadTs ?? thread.ts;
          }
        }

        if (!channel || !threadTs) {
          throw new Error(
            "Unable to infer thread. Provide --channel and --thread-ts or --message-url."
          );
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
          const result = await client.call("conversations.replies", {
            channel,
            ts: threadTs,
            limit: batchSize,
            cursor
          });

          const page = (result as { messages?: Array<Record<string, unknown>> }).messages ?? [];
          messages.push(...page);

          cursor = (result as { response_metadata?: { next_cursor?: string } }).response_metadata
            ?.next_cursor;

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

  program
    .command("ask")
    .description("Ask a question in a channel, with optional mention")
    .argument("<channel>", "Channel ID or name")
    .argument("<text>", "Question text")
    .option("--user <user>", "User to mention (@name, email, or ID)")
    .action(async (channelInput: string, text: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const channel = await resolveChannelId(client, channelInput);
        const mention = options.user ? `<@${await resolveUserId(client, options.user)}>` : "";
        const message = mention ? `${mention} ${text}` : text;
        const result = await client.postMessage({ channel, text: message });
        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  program
    .command("post")
    .description("Post a message to a channel")
    .argument("<channel>", "Channel ID or name")
    .argument("<text>", "Message text")
    .action(async (channelInput: string, text: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const channel = await resolveChannelId(client, channelInput);
        const result = await client.postMessage({ channel, text });
        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

function extractThreadFromItem(itemResult: Record<string, unknown>): { channel: string; ts: string } | null {
  const item = (itemResult as { item?: Record<string, unknown>; record?: Record<string, unknown> }).item ??
    (itemResult as { record?: Record<string, unknown> }).record;
  if (!item) {
    return null;
  }
  const fields = item.fields;
  if (!Array.isArray(fields)) {
    return null;
  }

  for (const field of fields) {
    if (!field || typeof field !== "object") {
      continue;
    }
    const messageEntries = (field as { message?: unknown }).message;
    if (Array.isArray(messageEntries) && messageEntries.length > 0) {
      const entry = messageEntries[0];
      if (typeof entry === "string") {
        const parsed = parseMessageUrl(entry);
        if (parsed) {
          return parsed;
        }
      }
      if (entry && typeof entry === "object") {
        const record = entry as { value?: unknown; channel_id?: unknown; ts?: unknown };
        if (record.channel_id && record.ts) {
          return { channel: String(record.channel_id), ts: String(record.ts) };
        }
        if (record.value) {
          const parsed = parseMessageUrl(String(record.value));
          if (parsed) {
            return parsed;
          }
        }
      }
    }
  }

  return null;
}
