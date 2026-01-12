import { Command } from "commander";

import { resolveToken } from "../lib/config";
import { resolveSchemaIndex } from "../lib/schema-resolver";
import { SlackListsClient } from "../lib/slack-client";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema")
    .description("Output compact schema for LLM-friendly list updates")
    .argument("<list-id>", "List ID")
    .action(async (listId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const schemaIndex = await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema);
        if (!schemaIndex) {
          throw new Error(
            "Schema unavailable. Provide --schema or ensure list has items to infer columns."
          );
        }

        const columns = schemaIndex.schema.columns.map((column) => {
          const compact: Record<string, unknown> = {
            id: column.id,
            key: column.key,
            name: column.name,
            type: column.type
          };

          if (column.options?.choices) {
            compact.options = {
              choices: column.options.choices.map((choice) => ({
                value: choice.value,
                label: choice.label
              }))
            };
          }

          return compact;
        });

        outputJson({ ok: true, list_id: listId, columns });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}
