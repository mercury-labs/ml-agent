import { Command } from "commander";

import { resolveToken } from "../lib/config";
import { buildTypedField, parseFieldArgument, resolveSelectValues } from "../lib/fields";
import {
  findColumnByKeyOrName,
  findColumnByType,
  findPrimaryTextColumn,
  resolveColumn,
  SchemaIndex
} from "../lib/schema";
import { inferSchemaFromItems } from "../lib/schema";
import { updateSchemaCache } from "../lib/cache";
import { resolveSchemaIndex } from "../lib/schema-resolver";
import { SlackListsClient } from "../lib/slack-client";
import { resolveUserId } from "../lib/resolvers";
import { getGlobalOptions } from "../utils/command";
import { handleCommandError } from "../utils/errors";
import { outputJson } from "../utils/output";

export function registerItemsCommands(program: Command): void {
  const items = program.command("items").description("Item operations");

  items
    .command("list")
    .description("List items in a list")
    .argument("<list-id>", "List ID")
    .option("--status <status>", "Filter by status")
    .option("--assignee <assignee>", "Filter by assignee")
    .option("--archived", "Include archived items", false)
    .option("--limit <limit>", "Maximum items to return")
    .action(async (listId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const schemaIndex =
          options.status || options.assignee
            ? await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema)
            : undefined;

        if ((options.status || options.assignee) && !schemaIndex) {
          throw new Error("Schema required for status/assignee filters. Provide --schema.");
        }

        const items = await fetchAllItems(client, listId, options.archived, options.limit);
        await syncSchemaCache(listId, items);
        let filtered = items;

        if (options.status && schemaIndex) {
          const statusColumn = resolveStatusColumn(schemaIndex);
          if (!statusColumn) {
            throw new Error("Unable to resolve status column from schema");
          }
          const expected = normalizeStatusValue(options.status, statusColumn);
          filtered = filtered.filter((item) => matchesStatus(item, statusColumn.id, expected, statusColumn.type));
        }

        if (options.assignee && schemaIndex) {
          const assigneeColumn = resolveAssigneeColumn(schemaIndex);
          if (!assigneeColumn) {
            throw new Error("Unable to resolve assignee column from schema");
          }
          const assigneeId = await resolveUserId(client, options.assignee);
          filtered = filtered.filter((item) => matchesAssignee(item, assigneeColumn.id, assigneeId));
        }

        outputJson({
          ok: true,
          list_id: listId,
          total_count: items.length,
          filtered_count: filtered.length,
          items: filtered
        });
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  items
    .command("get")
    .description("Get item details")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .action(async (listId: string, itemId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const result = await client.call("slackLists.items.info", { list_id: listId, item_id: itemId });
        const item = (result as { item?: Record<string, unknown> }).item;
        if (item) {
          await syncSchemaCache(listId, [item]);
        }
        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  items
    .command("create")
    .description("Create a new item")
    .argument("<list-id>", "List ID")
    .option("--name <name>", "Item name")
    .option("--assignee <assignee>", "Assignee")
    .option("--priority <priority>", "Priority")
    .option("--status <status>", "Status")
    .option("--due <date>", "Due date (YYYY-MM-DD)")
    .option("--field <field>", "Custom field override", collect, [])
    .action(async (listId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const schemaIndex = await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema);
        const initialFields: Record<string, unknown>[] = [];

        if (options.name) {
          if (!schemaIndex) {
            throw new Error("Schema required for --name. Provide --schema.");
          }
          const column = findPrimaryTextColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve primary text column from schema");
          }
          const typed = await buildTypedField(column, options.name, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.assignee) {
          if (!schemaIndex) {
            throw new Error("Schema required for --assignee. Provide --schema.");
          }
          const column = resolveAssigneeColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve assignee column from schema");
          }
          const typed = await buildTypedField(column, options.assignee, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.priority) {
          if (!schemaIndex) {
            throw new Error("Schema required for --priority. Provide --schema.");
          }
          const column = resolvePriorityColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve priority column from schema");
          }
          const typed = await buildTypedField(column, options.priority, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.status) {
          if (!schemaIndex) {
            throw new Error("Schema required for --status. Provide --schema.");
          }
          const column = resolveStatusColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve status column from schema");
          }
          const typed = await buildTypedField(column, options.status, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.due) {
          if (!schemaIndex) {
            throw new Error("Schema required for --due. Provide --schema.");
          }
          const column = resolveDueColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve due date column from schema");
          }
          const typed = await buildTypedField(column, options.due, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        for (const fieldArg of options.field ?? []) {
          const parsed = parseFieldArgument(fieldArg);
          if (parsed.kind === "json") {
            if (!("column_id" in parsed.value) && !("columnId" in parsed.value)) {
              throw new Error("Custom JSON field missing column_id");
            }
            const value = { ...parsed.value } as Record<string, unknown>;
            if (!("column_id" in value) && "columnId" in value) {
              value.column_id = value.columnId;
              delete value.columnId;
            }
            initialFields.push(value);
            continue;
          }

          if (!schemaIndex) {
            throw new Error("Schema required for --field key=value entries. Provide --schema.");
          }
          const column = resolveColumn(schemaIndex, parsed.key);
          if (!column) {
            throw new Error(`Unknown column: ${parsed.key}`);
          }
          const typed = await buildTypedField(column, parsed.value, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (initialFields.length === 0) {
          throw new Error("No fields provided. Use --name or --field to set values.");
        }

        const result = await client.call("slackLists.items.create", {
          list_id: listId,
          initial_fields: initialFields
        });

        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  items
    .command("update")
    .description("Update item fields")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .option("--assignee <assignee>", "Assignee")
    .option("--priority <priority>", "Priority")
    .option("--status <status>", "Status")
    .option("--due <date>", "Due date (YYYY-MM-DD)")
    .option("--field <field>", "Custom field override", collect, [])
    .action(async (listId: string, itemId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const schemaIndex = await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema);
        const cells: Record<string, unknown>[] = [];

        if (options.assignee) {
          if (!schemaIndex) {
            throw new Error("Schema required for --assignee. Provide --schema.");
          }
          const column = resolveAssigneeColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve assignee column from schema");
          }
          const typed = await buildTypedField(column, options.assignee, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (options.priority) {
          if (!schemaIndex) {
            throw new Error("Schema required for --priority. Provide --schema.");
          }
          const column = resolvePriorityColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve priority column from schema");
          }
          const typed = await buildTypedField(column, options.priority, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (options.status) {
          if (!schemaIndex) {
            throw new Error("Schema required for --status. Provide --schema.");
          }
          const column = resolveStatusColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve status column from schema");
          }
          const typed = await buildTypedField(column, options.status, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (options.due) {
          if (!schemaIndex) {
            throw new Error("Schema required for --due. Provide --schema.");
          }
          const column = resolveDueColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve due date column from schema");
          }
          const typed = await buildTypedField(column, options.due, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        for (const fieldArg of options.field ?? []) {
          const parsed = parseFieldArgument(fieldArg);
          if (parsed.kind === "json") {
            const value = { ...parsed.value } as Record<string, unknown>;
            if (!("column_id" in value) && "columnId" in value) {
              value.column_id = value.columnId;
              delete value.columnId;
            }
            if (!("column_id" in value)) {
              throw new Error("Custom JSON field missing column_id");
            }
            cells.push({ row_id: itemId, ...value });
            continue;
          }

          if (!schemaIndex) {
            throw new Error("Schema required for --field key=value entries. Provide --schema.");
          }
          const column = resolveColumn(schemaIndex, parsed.key);
          if (!column) {
            throw new Error(`Unknown column: ${parsed.key}`);
          }
          const typed = await buildTypedField(column, parsed.value, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (cells.length === 0) {
          throw new Error("No fields provided. Use --field or other flags to update values.");
        }

        const result = await client.call("slackLists.items.update", {
          list_id: listId,
          cells
        });

        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });

  items
    .command("delete")
    .description("Delete an item")
    .argument("<list-id>", "List ID")
    .argument("<item-id>", "Item ID")
    .action(async (listId: string, itemId: string, _options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const result = await client.call("slackLists.items.delete", { list_id: listId, item_id: itemId });
        outputJson(result);
      } catch (error) {
        handleCommandError(error, globals.verbose);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function syncSchemaCache(listId: string, items: Record<string, unknown>[]): Promise<void> {
  try {
    const inferred = inferSchemaFromItems(listId, items);
    await updateSchemaCache(listId, inferred);
  } catch {
    // Best-effort cache update; do not fail commands if schema sync fails.
  }
}

async function fetchAllItems(
  client: SlackListsClient,
  listId: string,
  archived: boolean,
  limitOption?: string
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = undefined;
  const limit = limitOption ? Number(limitOption) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  do {
    const result = await client.call("slackLists.items.list", {
      list_id: listId,
      limit: 100,
      cursor,
      archived: archived ? true : undefined
    });

    const page = (result as { items?: Array<Record<string, unknown>> }).items ?? [];
    items.push(...page);

    cursor = (result as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;

    if (limit && items.length >= limit) {
      break;
    }
  } while (cursor);

  if (limit && items.length > limit) {
    return items.slice(0, limit);
  }

  return items;
}

function resolveStatusColumn(index: SchemaIndex) {
  const todoCompleted = findColumnByType(index, ["todo_completed"]);
  if (todoCompleted) {
    return todoCompleted;
  }
  return pickSelectColumn(index, "status", ["status", "state"]);
}

function resolvePriorityColumn(index: SchemaIndex) {
  return pickSelectColumn(index, "priority", ["priority"]);
}

function resolveAssigneeColumn(index: SchemaIndex) {
  return (
    findColumnByType(index, ["todo_assignee", "user"]) ??
    findColumnByKeyOrName(index, ["assignee", "owner"])
  );
}

function resolveDueColumn(index: SchemaIndex) {
  return (
    findColumnByType(index, ["todo_due_date", "date"]) ??
    findColumnByKeyOrName(index, ["due", "due_date"])
  );
}

function pickSelectColumn(index: SchemaIndex, label: string, keys: string[]) {
  const byKey = findColumnByKeyOrName(index, keys);
  if (byKey) {
    return byKey;
  }

  const selects = index.schema.columns.filter((column) => column.type === "select");
  if (selects.length === 1) {
    return selects[0];
  }
  if (selects.length > 1) {
    throw new Error(`Multiple select columns found; specify --field with column key for ${label}.`);
  }
  return undefined;
}

function normalizeStatusValue(value: string, column: { type: string; options?: { choices?: { value: string; label?: string }[] } }): string[] | boolean {
  if (column.type === "todo_completed") {
    return ["completed", "done", "true", "yes", "1"].includes(value.toLowerCase());
  }
  if (column.type === "select") {
    return resolveSelectValues(column as never, value);
  }
  return [value];
}

function matchesStatus(
  item: Record<string, unknown>,
  columnId: string,
  expected: string[] | boolean,
  columnType: string
): boolean {
  const field = findField(item, columnId);
  if (!field) {
    return false;
  }

  if (columnType === "todo_completed") {
    const checkbox = (field as { checkbox?: unknown }).checkbox;
    if (typeof checkbox === "boolean") {
      return checkbox === expected;
    }
    const rawValue = (field as { value?: unknown }).value;
    if (typeof rawValue === "string") {
      try {
        const parsed = JSON.parse(rawValue) as { checkbox?: unknown };
        if (typeof parsed.checkbox === "boolean") {
          return parsed.checkbox === expected;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const select = (field as { select?: unknown }).select;
  if (Array.isArray(select)) {
    return expectedValues.some((value) => select.includes(value as string));
  }

  const rawValue = (field as { value?: unknown }).value;
  if (typeof rawValue === "string") {
    return expectedValues.some((value) => rawValue.includes(String(value)));
  }

  return false;
}

function matchesAssignee(item: Record<string, unknown>, columnId: string, assigneeId: string): boolean {
  const field = findField(item, columnId);
  if (!field) {
    return false;
  }

  const users = (field as { user?: unknown }).user;
  if (Array.isArray(users)) {
    return users.includes(assigneeId);
  }

  const rawValue = (field as { value?: unknown }).value;
  if (typeof rawValue === "string") {
    return rawValue.includes(assigneeId);
  }

  return false;
}

function findField(item: Record<string, unknown>, columnId: string): Record<string, unknown> | null {
  const fields = item.fields;
  if (!Array.isArray(fields)) {
    return null;
  }

  for (const field of fields) {
    if (field && typeof field === "object" && (field as { column_id?: string }).column_id === columnId) {
      return field as Record<string, unknown>;
    }
  }

  return null;
}
