import { Command } from "commander";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { resolveToken } from "../lib/config";
import { SlackListsClient } from "../lib/slack-client";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";
import { inferSchemaFromItems } from "../lib/schema";
import { updateSchemaCache } from "../lib/cache";

export function registerListsCommands(program: Command): void {
  const lists = program.command("lists").description("List operations");

  lists
    .description("List accessible lists (if supported by Slack API)")
    .action(async (_options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const result = await client.call("slackLists.list", {});
        outputJson(result);
      } catch (error) {
        const slackError = (error as { data?: { error?: string } }).data?.error;
        if (slackError === "unknown_method") {
          outputJson({
            ok: false,
            error: "list_discovery_not_supported",
            message:
              "Slack does not expose a list discovery API. Provide list IDs directly or create lists via the UI/API."
          });
          return;
        }
        handleCommandError(error, globals.verbose);
      }
    });

  lists
    .command("info")
    .description("Get list details and schema")
    .argument("<list-id>", "List ID")
    .action(async (listId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const result = await client.call("slackLists.info", { list_id: listId });
        outputJson(result);
      } catch (error) {
        const slackError = (error as { data?: { error?: string } }).data?.error;
          if (slackError === "unknown_method") {
            try {
              const itemsResult = await client.call("slackLists.items.list", {
                list_id: listId,
                limit: 1
              });
              const items = (itemsResult as { items?: unknown[] }).items ?? [];
            const inferred = inferSchemaFromItems(listId, items);
            await updateSchemaCache(listId, inferred);
            outputJson({
              ok: true,
                list_id: listId,
                inferred_schema: inferred,
                note:
                  "Schema inferred from existing item fields; select options and empty-list columns are not discoverable."
              });
              return;
            } catch (fallbackError) {
              handleCommandError(fallbackError, globals.verbose);
            }
          }
        handleCommandError(error, globals.verbose);
      }
    });

  lists
    .command("export")
    .description("Export a list via Slack's download job")
    .argument("<list-id>", "List ID")
    .option("--format <format>", "json|csv (best-effort)", "json")
    .option("--out <path>", "Write export to a file instead of JSON output")
    .option("--poll-interval <ms>", "Polling interval in ms", "2000")
    .option("--timeout <ms>", "Max time to wait for export", "60000")
    .action(async (listId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const startResult = await client.call("slackLists.download.start", { list_id: listId });
        const jobId = (startResult as { job_id?: string }).job_id;
        if (!jobId) {
          throw new Error("Missing job_id from slackLists.download.start");
        }

        const pollIntervalMs = Number(options.pollInterval);
        const timeoutMs = Number(options.timeout);
        if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
          throw new Error("--poll-interval must be a positive number");
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number");
        }
        const startTime = Date.now();
        let downloadUrl: string | undefined;
        let status: string | undefined;

        while (Date.now() - startTime < timeoutMs) {
          const pollResult = await client.call("slackLists.download.get", { job_id: jobId });
          downloadUrl = (pollResult as { download_url?: string }).download_url;
          status = (pollResult as { status?: string }).status;
          if (downloadUrl) {
            break;
          }
          if (status && ["failed", "canceled", "error"].includes(status.toLowerCase())) {
            throw new Error(`Download job failed with status: ${status}`);
          }
          await sleep(pollIntervalMs);
        }

        if (!downloadUrl) {
          throw new Error("Download job did not complete within timeout");
        }

        const response = await fetchWithRetry(downloadUrl);
        if (!response.ok || !response.body) {
          throw new Error(`Failed to download export: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type");

        if (options.out) {
          const bodyStream = Readable.fromWeb(response.body as any);
          await pipeline(bodyStream, createWriteStream(options.out));
          outputJson({
            ok: true,
            job_id: jobId,
            download_url: downloadUrl,
            saved_to: options.out,
            content_type: contentType
          });
          return;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const bodyBase64 = buffer.toString("base64");
        outputJson({
          ok: true,
          job_id: jobId,
          download_url: downloadUrl,
          content_type: contentType,
          format: options.format,
          body_base64: bodyBase64,
          size_bytes: buffer.length,
          encoding: "base64"
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let attempt = 0;
  while (attempt < attempts) {
    const response = await fetch(url);
    if (response.status !== 429) {
      return response;
    }
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 1;
    await sleep(Math.max(retryAfterSeconds, 1) * 1000);
    attempt += 1;
  }

  return fetch(url);
}
