import { Command } from "commander";
import { createReadStream, promises as fs } from "fs";
import path from "path";

import { resolveDefaultChannel, resolveToken } from "../lib/config";
import { resolveEvidenceColumn } from "../lib/evidence";
import { buildTypedField } from "../lib/fields";
import { extractFileId, extractFilePermalink } from "../lib/file-utils";
import { parseMessageUrl, resolveChannelId } from "../lib/resolvers";
import { resolveSchemaIndex } from "../lib/schema-resolver";
import { createTempScreenshotPath, captureScreenshot, ensurePngPath } from "../lib/screenshot";
import { SlackListsClient } from "../lib/slack-client";
import { buildThreadRootText, extractThreadFromItem } from "../lib/thread-utils";
import { getThreadEntry, setThreadEntry } from "../lib/thread-map";
import { findColumnByType } from "../lib/schema";
import { ColumnType } from "../lib/types";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

export function registerScreenshotCommands(program: Command): void {
  const screenshot = program.command("screenshot").description("Capture and share browser screenshots");

  screenshot
    .command("capture")
    .description("Capture a headless browser screenshot")
    .argument("<url>", "URL or file path")
    .option("--out <path>", "Output path (defaults to ./screenshot-<timestamp>.png)")
    .option("--full", "Capture full page", false)
    .option("--selector <selector>", "Capture a specific element (CSS selector)")
    .option("--wait-for <selector>", "Wait for selector before capture")
    .option("--wait <ms>", "Wait milliseconds after load", "0")
    .option("--timeout <ms>", "Navigation timeout in ms", "30000")
    .option("--wait-until <event>", "load|domcontentloaded|networkidle", "load")
    .option("--width <px>", "Viewport width", "1280")
    .option("--height <px>", "Viewport height", "720")
    .action(async (url: string, options, command: Command) => {
      const globals = getGlobalOptions(command);

      try {
        const outputPath = ensurePngPath(options.out ?? defaultScreenshotPath());
        const captureOptions = buildCaptureOptions(url, outputPath, options);
        const result = await captureScreenshot(captureOptions);

        outputJson({ ok: true, ...result });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  screenshot
    .command("post")
    .description("Capture a screenshot and upload to Slack")
    .argument("<url>", "URL or file path")
    .option("--channel <channel>", "Channel ID or name")
    .option("--thread-ts <ts>", "Thread timestamp")
    .option("--message-url <url>", "Slack message URL to infer thread")
    .option("--comment <text>", "Optional comment to include with the upload")
    .option("--title <text>", "Optional title for the uploaded file")
    .option("--list-id <list-id>", "List ID to attach the screenshot")
    .option("--item-id <item-id>", "Item ID to attach the screenshot")
    .option("--column <column>", "Column ID/key/name to update")
    .option("--column-type <type>", "attachment|reference", "attachment")
    .option("--out <path>", "Output path (defaults to a temp file)")
    .option("--keep", "Keep the screenshot file after upload", false)
    .option("--full", "Capture full page", false)
    .option("--selector <selector>", "Capture a specific element (CSS selector)")
    .option("--wait-for <selector>", "Wait for selector before capture")
    .option("--wait <ms>", "Wait milliseconds after load", "0")
    .option("--timeout <ms>", "Navigation timeout in ms", "30000")
    .option("--wait-until <event>", "load|domcontentloaded|networkidle", "load")
    .option("--width <px>", "Viewport width", "1280")
    .option("--height <px>", "Viewport height", "720")
    .action(async (url: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      const outputPath = ensurePngPath(options.out ?? createTempScreenshotPath());
      const shouldCleanup = !options.out && !options.keep;

      try {
        const captureOptions = buildCaptureOptions(url, outputPath, options);
        const screenshotResult = await captureScreenshot(captureOptions);

        const listId = options.listId as string | undefined;
        const itemId = options.itemId as string | undefined;
        if ((listId && !itemId) || (!listId && itemId)) {
          throw new Error("Provide both --list-id and --item-id to attach to a list item.");
        }

        let channel = options.channel ? await resolveChannelId(client, options.channel) : undefined;
        let threadTs = options.threadTs as string | undefined;
        let messageUrl = options.messageUrl as string | undefined;

        if ((!channel || !threadTs) && messageUrl) {
          const parsed = parseMessageUrl(messageUrl);
          if (parsed) {
            channel = channel ?? parsed.channel;
            threadTs = threadTs ?? parsed.ts;
          }
        }

        if ((!channel || !threadTs) && listId && itemId) {
          const stored = await getThreadEntry(listId, itemId);
          if (stored?.permalink) {
            const parsed = parseMessageUrl(stored.permalink);
            if (parsed) {
              channel = channel ?? parsed.channel;
              threadTs = threadTs ?? parsed.ts;
              messageUrl = messageUrl ?? stored.permalink;
            }
          }
          if (stored?.channel && stored?.ts) {
            channel = channel ?? stored.channel;
            threadTs = threadTs ?? stored.ts;
          }
        }

        let itemResult: Record<string, unknown> | null = null;
        if ((!channel || !threadTs) && listId && itemId) {
          itemResult = (await client.call("slackLists.items.info", {
            list_id: listId,
            id: itemId
          })) as unknown as Record<string, unknown>;
          const thread = extractThreadFromItem(itemResult);
          if (thread) {
            channel = channel ?? thread.channel;
            threadTs = threadTs ?? thread.ts;
            messageUrl = messageUrl ?? thread.permalink;
          }
        }

        if (!channel && listId) {
          const fallback = resolveDefaultChannel(listId);
          if (fallback) {
            channel = await resolveChannelId(client, fallback);
          }
        }

        const wantsThread = Boolean(options.comment || options.threadTs || options.messageUrl);
        if (!threadTs && channel && listId && itemId && wantsThread) {
          const root = await createThreadRoot(
            client,
            listId,
            itemId,
            channel,
            globals,
            itemResult ?? undefined
          );
          threadTs = root.threadTs;
          messageUrl = messageUrl ?? root.permalink;
        }

        if (!channel) {
          throw new Error("Provide --channel (or set SLACK_LIST_DEFAULT_CHANNEL) to upload a screenshot.");
        }

        if (messageUrl && listId && itemId && channel && threadTs) {
          await setThreadEntry(listId, itemId, {
            permalink: messageUrl,
            channel,
            ts: threadTs
          });
        }

        const filename = path.basename(outputPath);
        const title = options.title ?? filename;
        const uploadPayload: Record<string, unknown> = {
          file: createReadStream(outputPath),
          filename,
          title,
          channel_id: channel
        };

        if (threadTs) {
          uploadPayload.thread_ts = threadTs;
        }
        if (options.comment) {
          uploadPayload.initial_comment = options.comment;
        }

        const uploadResult = await client.filesUploadV2(uploadPayload);
        const fileId = extractFileId(uploadResult as unknown as Record<string, unknown>);
        const permalink = extractFilePermalink(uploadResult as unknown as Record<string, unknown>);

        let updateResult: unknown = undefined;
        let columnId: string | undefined = undefined;
        if (listId && itemId) {
          const schemaIndex = await resolveSchemaIndex(
            client,
            listId,
            globals.schema,
            globals.refreshSchema
          );
          const columnType = options.columnType as ColumnType;
          if (!["attachment", "reference"].includes(columnType)) {
            throw new Error("--column-type must be attachment or reference");
          }
          const column = resolveEvidenceColumn(schemaIndex, options.column, columnType, [
            "attachment",
            "reference"
          ]);
          columnId = column.id;

          const typed = await buildTypedField(column, fileId, { client });
          updateResult = await client.call("slackLists.items.update", {
            list_id: listId,
            cells: [{ row_id: itemId, column_id: column.id, ...typed }]
          });
        }

        outputJson({
          ok: true,
          screenshot: {
            path: screenshotResult.path,
            bytes: screenshotResult.bytes,
            url: screenshotResult.url,
            width: screenshotResult.width,
            height: screenshotResult.height,
            full_page: screenshotResult.fullPage,
            selector: screenshotResult.selector
          },
          channel,
          thread_ts: threadTs,
          file_id: fileId,
          file_permalink: permalink,
          list_id: listId,
          item_id: itemId,
          column_id: columnId,
          slack: {
            upload: uploadResult,
            update: updateResult
          }
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      } finally {
        if (shouldCleanup) {
          await fs.rm(outputPath, { force: true });
        }
      }
    });
}

function buildCaptureOptions(url: string, outputPath: string, options: Record<string, unknown>) {
  const width = parseNumberOption(options.width as string | undefined, 1280, "--width");
  const height = parseNumberOption(options.height as string | undefined, 720, "--height");
  const waitMs = parseNumberOption(options.wait as string | undefined, 0, "--wait");
  const timeoutMs = parseNumberOption(options.timeout as string | undefined, 30_000, "--timeout");
  const waitUntil = parseWaitUntil(options.waitUntil as string | undefined);
  const selector = options.selector as string | undefined;
  const waitFor = options.waitFor as string | undefined;

  return {
    url,
    outputPath,
    fullPage: Boolean(options.full) && !selector,
    selector,
    waitFor,
    waitUntil,
    waitMs,
    timeoutMs,
    width,
    height
  };
}

function parseNumberOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return num;
}

function parseWaitUntil(value: string | undefined): "load" | "domcontentloaded" | "networkidle" {
  if (!value) {
    return "load";
  }
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") {
    return value;
  }
  throw new Error("--wait-until must be load, domcontentloaded, or networkidle");
}

function defaultScreenshotPath(): string {
  return `screenshot-${Date.now()}.png`;
}

async function createThreadRoot(
  client: SlackListsClient,
  listId: string,
  itemId: string,
  channel: string,
  globals: { schema?: string; refreshSchema?: boolean },
  itemResult?: Record<string, unknown>
): Promise<{ threadTs: string; permalink: string }> {
  const details =
    itemResult ??
    ((await client.call("slackLists.items.info", {
      list_id: listId,
      id: itemId
    })) as unknown as Record<string, unknown>);

  const rootText = buildThreadRootText(details, listId, itemId);
  const root = await client.postMessage({ channel, text: rootText });
  const rootTs = (root as { ts?: string }).ts;
  if (!rootTs) {
    throw new Error("Unable to create thread root message");
  }

  const permalinkResult = await client.call("chat.getPermalink", {
    channel,
    message_ts: rootTs
  });
  const permalink = (permalinkResult as { permalink?: string }).permalink;
  if (!permalink) {
    throw new Error("Unable to fetch permalink for thread root");
  }

  const schemaIndex = await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema);
  const messageColumn = schemaIndex ? findColumnByType(schemaIndex, ["message"]) : undefined;
  if (messageColumn) {
    await client.call("slackLists.items.update", {
      list_id: listId,
      cells: [
        {
          row_id: itemId,
          column_id: messageColumn.id,
          message: [permalink]
        }
      ]
    });
  }

  await setThreadEntry(listId, itemId, {
    permalink,
    channel,
    ts: rootTs
  });

  return { threadTs: rootTs, permalink };
}
