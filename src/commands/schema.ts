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
    .option("--for-update", "Include update hints for agents", false)
    .action(async (listId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const schemaIndex = await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema);
        if (!schemaIndex) {
          throw new Error(
            "Schema unavailable. Provide --schema or ensure list has items to infer columns."
          );
        }

        const columns: CompactColumn[] = schemaIndex.schema.columns.map((column) => {
          const compact: CompactColumn = {
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

        const response: Record<string, unknown> = { ok: true, list_id: listId, columns };
        if (options.forUpdate) {
          response.update_hints = buildUpdateHints(listId, columns);
        }

        outputJson(response);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

type CompactColumn = {
  id: string;
  key?: string;
  name?: string;
  type?: string;
  options?: { choices?: Array<{ value: string; label?: string }> };
};

function buildUpdateHints(listId: string, columns: CompactColumn[]) {
  const fields = columns.map((column) => {
    const flag = inferFlag(column);
    const valueHint = inferValueHint(column);
    return {
      id: column.id,
      key: column.key,
      name: column.name,
      type: column.type,
      set_with: flag,
      value_hint: valueHint,
      choices: column.options?.choices ?? undefined
    };
  });

  const examples = fields
    .filter((field) => field.set_with)
    .slice(0, 4)
    .map((field) => {
      const value = exampleValue(field);
      return `ml-agent items update ${listId} <item-id> ${field.set_with} ${value}`;
    });

  return { fields, examples };
}

function inferFlag(column: CompactColumn): string | null {
  const key = (column.key ?? "").toLowerCase();
  const name = (column.name ?? "").toLowerCase();

  if (key === "name" || name === "task" || name === "title") {
    return "--name";
  }
  if (key === "status") {
    return "--status";
  }
  if (key === "agent_state" || name === "agent state") {
    return "--agent-state";
  }
  if (key === "priority") {
    return "--priority";
  }
  if (key === "assignee" || key === "owner") {
    return "--assignee";
  }
  if (key.includes("date") || key.includes("due") || name.includes("date") || name.includes("due")) {
    return "--due";
  }
  return "--field";
}

function inferValueHint(column: CompactColumn): string | string[] | null {
  if (column.type === "select" && column.options?.choices?.length) {
    return column.options.choices.map((choice) => choice.value);
  }
  if (column.type === "rating") {
    const max = (column.options as { max?: number } | undefined)?.max;
    return max ? `1..${max}` : "1..n";
  }
  if (column.type === "user") {
    return "@user | email | U123";
  }
  if (column.type === "date") {
    return "YYYY-MM-DD";
  }
  if (column.type === "message") {
    return "Slack message permalink URL";
  }
  if (column.type === "number") {
    return "number";
  }
  return null;
}

function exampleValue(field: { set_with?: string | null; choices?: Array<{ value: string }> | undefined; value_hint?: unknown }) {
  if (!field.set_with) {
    return "\"value\"";
  }
  if (field.set_with === "--status" && field.choices?.length) {
    return field.choices[0].value;
  }
  if (field.set_with === "--priority") {
    return "1";
  }
  if (field.set_with === "--assignee") {
    return "@user";
  }
  if (field.set_with === "--due") {
    return "2026-01-15";
  }
  if (field.set_with === "--name") {
    return "\"Task name\"";
  }
  return "\"value\"";
}
