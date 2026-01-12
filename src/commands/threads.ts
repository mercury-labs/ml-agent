import { Command } from "commander";

import { resolveToken } from "../lib/config";
import { parseMessageUrl, resolveChannelId } from "../lib/resolvers";
import { SlackListsClient } from "../lib/slack-client";
import { getThreadEntry, setThreadEntry } from "../lib/thread-map";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

export function registerThreadsCommands(program: Command): void {
  const threads = program.command("threads").description("Manage per-item thread mapping");

  threads
    .command("get")
    .description("Get stored thread mapping for an item")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .action(async (listId: string, itemId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      try {
        const entry = await getThreadEntry(listId, itemId);
        outputJson({ ok: true, list_id: listId, item_id: itemId, thread: entry });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  threads
    .command("set")
    .description("Store thread mapping for an item")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .option("--message-url <url>", "Slack message URL")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .action(async (listId: string, itemId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const url = options.messageUrl as string | undefined;
        let channel = options.channel ? await resolveChannelId(client, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;

        if (url) {
          const parsed = parseMessageUrl(url);
          if (!parsed) {
            throw new Error("Unable to parse message URL");
          }
          channel = channel ?? parsed.channel;
          threadTs = threadTs ?? parsed.ts;
        }

        if (!channel || !threadTs) {
          throw new Error("Provide --message-url or both --channel and --thread-ts");
        }

        await setThreadEntry(listId, itemId, {
          permalink: url,
          channel,
          ts: threadTs
        });

        outputJson({ ok: true, list_id: listId, item_id: itemId, channel, thread_ts: threadTs, permalink: url });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}
