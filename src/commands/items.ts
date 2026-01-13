import { Command } from "commander";

import { resolveToken } from "../lib/config";
import { buildTypedField, parseFieldArgument, resolveSelectValues } from "../lib/fields";
import {
  findColumnByKeyOrName,
  findColumnByType,
  findPrimaryTextColumn,
  normalizeSchema,
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
    .option("--compact", "Return minimal fields", false)
    .action(async (listId: string, options, command: Command) => {
      const globals = getGlobalOptions(command);
      const client = new SlackListsClient(resolveToken(globals));

      try {
        const items = await fetchAllItems(client, listId, options.archived, options.limit);
        await syncSchemaCache(listId, items);
        const schemaIndex =
          options.status || options.assignee || options.compact
            ? await resolveSchemaIndex(client, listId, globals.schema, globals.refreshSchema)
            : undefined;

        if ((options.status || options.assignee) && !schemaIndex) {
          throw new Error(
            "Schema required for status/assignee filters. Run 'items list' once to seed cache, or provide --schema."
          );
        }
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

        const outputItems = options.compact
          ? filtered.map((item) => toCompactItem(item, schemaIndex))
          : filtered;

        outputJson({
          ok: true,
          list_id: listId,
          total_count: items.length,
          filtered_count: filtered.length,
          compact: Boolean(options.compact),
          items: outputItems
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
        const result = await client.call("slackLists.items.info", { list_id: listId, id: itemId });
        try {
          const list = (result as { list?: { list_metadata?: Record<string, unknown>; id?: string } }).list;
          if (list?.list_metadata) {
            const schema = normalizeSchema({
              list_metadata: list.list_metadata,
              list_id: list.id ?? listId
            });
            await updateSchemaCache(listId, schema);
          }
        } catch {
          // Best-effort cache update; ignore schema parsing errors.
        }
        const item =
          (result as { item?: Record<string, unknown>; record?: Record<string, unknown> }).item ??
          (result as { record?: Record<string, unknown> }).record;
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
    .option("--agent-state <state>", "Agent state (needs_input|in_progress|blocked|ready_for_review|ready_for_test)")
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
            throw new Error(schemaRequired("--name"));
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
            throw new Error(schemaRequired("--assignee"));
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
            throw new Error(schemaRequired("--priority"));
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
            throw new Error(schemaRequired("--status"));
          }
          const column = resolveStatusColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve status column from schema");
          }
          const typed = await buildTypedField(column, options.status, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.agentState) {
          if (!schemaIndex) {
            throw new Error(schemaRequired("--agent-state"));
          }
          const column = resolveAgentStateColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve agent state column from schema");
          }
          const typed = await buildTypedField(column, options.agentState, { client });
          initialFields.push({ column_id: column.id, ...typed });
        }

        if (options.due) {
          if (!schemaIndex) {
            throw new Error(schemaRequired("--due"));
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
            throw new Error(schemaRequired("--field"));
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
    .option("--agent-state <state>", "Agent state (needs_input|in_progress|blocked|ready_for_review|ready_for_test)")
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
            throw new Error(schemaRequired("--assignee"));
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
            throw new Error(schemaRequired("--priority"));
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
            throw new Error(schemaRequired("--status"));
          }
          const column = resolveStatusColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve status column from schema");
          }
          const typed = await buildTypedField(column, options.status, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (options.agentState) {
          if (!schemaIndex) {
            throw new Error(schemaRequired("--agent-state"));
          }
          const column = resolveAgentStateColumn(schemaIndex);
          if (!column) {
            throw new Error("Unable to resolve agent state column from schema");
          }
          const typed = await buildTypedField(column, options.agentState, { client });
          cells.push({ row_id: itemId, column_id: column.id, ...typed });
        }

        if (options.due) {
          if (!schemaIndex) {
            throw new Error(schemaRequired("--due"));
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
            throw new Error(schemaRequired("--field"));
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
        const result = await client.call("slackLists.items.delete", { list_id: listId, id: itemId });
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

function resolveAgentStateColumn(index: SchemaIndex) {
  return findColumnByKeyOrName(index, ["agent_state", "agent state", "agentstatus", "agent_status"]);
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

function schemaRequired(flag: string): string {
  return `Schema required for ${flag}. Run 'ml-agent items list <list-id>' to seed the cache (if the list has items), or provide --schema.`;
}

function toCompactItem(item: Record<string, unknown>, schemaIndex?: SchemaIndex) {
  const nameField =
    findFieldByKey(item, "name") ??
    (schemaIndex ? findField(item, findPrimaryTextColumn(schemaIndex)?.id ?? "") : null);
  const statusColumn = schemaIndex ? findStatusColumn(schemaIndex) : undefined;
  const assigneeColumn = schemaIndex ? resolveAssigneeColumn(schemaIndex) : undefined;
  const priorityColumn = schemaIndex ? findPriorityColumn(schemaIndex) : undefined;
  const dueColumn = schemaIndex ? resolveDueColumn(schemaIndex) : undefined;

  const statusField =
    findFieldByKey(item, "status") ??
    (statusColumn ? findField(item, statusColumn.id) : null);
  const assigneeField =
    findFieldByKey(item, "assignee") ??
    (assigneeColumn ? findField(item, assigneeColumn.id) : null);
  const priorityField =
    findFieldByKey(item, "priority") ??
    (priorityColumn ? findField(item, priorityColumn.id) : null);
  const agentStateField =
    findFieldByKey(item, "agent_state") ??
    (schemaIndex ? findField(item, resolveAgentStateColumn(schemaIndex)?.id ?? "") : null);
  const dueField =
    findFieldByKey(item, "date") ??
    (dueColumn ? findField(item, dueColumn.id) : null);
  const messageField =
    (schemaIndex ? findField(item, findColumnByType(schemaIndex, ["message"])?.id ?? "") : null) ??
    findFieldByKey(item, "message");

  return {
    id: item.id,
    list_id: item.list_id,
    name: extractText(nameField),
    status: extractSelect(statusField),
    assignee: extractUsers(assigneeField),
    priority: extractRating(priorityField),
    agent_state: extractSelect(agentStateField),
    due_date: extractDate(dueField),
    message: extractMessage(messageField),
    updated_timestamp: item.updated_timestamp ?? item.updated_ts
  };
}

function findFieldByKey(item: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const fields = item.fields;
  if (!Array.isArray(fields)) {
    return null;
  }

  const target = key.toLowerCase();
  for (const field of fields) {
    if (field && typeof field === "object") {
      const fieldKey = (field as { key?: string }).key;
      if (typeof fieldKey === "string" && fieldKey.toLowerCase() === target) {
        return field as Record<string, unknown>;
      }
    }
  }

  return null;
}

function findStatusColumn(index: SchemaIndex) {
  return findColumnByKeyOrName(index, ["status", "state"]) ?? findColumnByType(index, ["todo_completed"]);
}

function findPriorityColumn(index: SchemaIndex) {
  return findColumnByKeyOrName(index, ["priority"]) ?? findColumnByType(index, ["rating"]);
}

function extractText(field: Record<string, unknown> | null): string | null {
  if (!field) {
    return null;
  }

  if (typeof field.text === "string" && field.text.trim()) {
    return field.text;
  }

  const richText = field.rich_text;
  if (Array.isArray(richText)) {
    for (const block of richText) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const elements = (block as { elements?: unknown }).elements;
      if (!Array.isArray(elements)) {
        continue;
      }
      for (const element of elements) {
        if (!element || typeof element !== "object") {
          continue;
        }
        const inner = (element as { elements?: unknown }).elements;
        if (!Array.isArray(inner)) {
          continue;
        }
        for (const node of inner) {
          if (node && typeof node === "object" && typeof (node as { text?: unknown }).text === "string") {
            return String((node as { text?: unknown }).text);
          }
        }
      }
    }
  }

  if (typeof field.value === "string") {
    return field.value;
  }

  return null;
}

function extractSelect(field: Record<string, unknown> | null): string | string[] | null {
  if (!field) {
    return null;
  }
  const select = field.select;
  if (Array.isArray(select)) {
    return select.length === 1 ? select[0] : select;
  }
  if (typeof field.value === "string") {
    return field.value;
  }
  return null;
}

function extractUsers(field: Record<string, unknown> | null): string | string[] | null {
  if (!field) {
    return null;
  }
  const users = field.user;
  if (Array.isArray(users)) {
    return users.length === 1 ? users[0] : users;
  }
  if (typeof field.value === "string") {
    return field.value;
  }
  return null;
}

function extractRating(field: Record<string, unknown> | null): number | null {
  if (!field) {
    return null;
  }
  const rating = field.rating;
  if (Array.isArray(rating) && rating.length > 0) {
    return Number(rating[0]);
  }
  if (typeof field.value === "number") {
    return field.value;
  }
  if (typeof field.value === "string") {
    const parsed = Number(field.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractDate(field: Record<string, unknown> | null): string | null {
  if (!field) {
    return null;
  }
  const date = field.date;
  if (Array.isArray(date) && date.length > 0) {
    return String(date[0]);
  }
  if (typeof field.value === "string") {
    return field.value;
  }
  return null;
}

function extractMessage(field: Record<string, unknown> | null): string | null {
  if (!field) {
    return null;
  }
  const message = field.message;
  if (Array.isArray(message) && message.length > 0) {
    const entry = message[0];
    if (typeof entry === "string") {
      return entry;
    }
    if (entry && typeof entry === "object") {
      const value = (entry as { value?: unknown }).value;
      if (typeof value === "string") {
        return value;
      }
    }
  }
  if (typeof field.value === "string") {
    return field.value;
  }
  return null;
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
