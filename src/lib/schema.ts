import { promises as fs } from "fs";

import { ColumnType, ListColumn, ListSchema } from "./types";

export type SchemaIndex = {
  schema: ListSchema;
  byId: Map<string, ListColumn>;
  byKey: Map<string, ListColumn>;
  byName: Map<string, ListColumn>;
};

export async function loadSchemaFromFile(filePath: string): Promise<ListSchema> {
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  return normalizeSchema(data);
}

export function normalizeSchema(data: Record<string, unknown>): ListSchema {
  if (data.list_metadata && typeof data.list_metadata === "object") {
    const metadata = data.list_metadata as Record<string, unknown>;
    const schema = metadata.schema ?? metadata.columns;
    if (Array.isArray(schema)) {
      return buildSchemaFromRaw(metadata.id ?? data.list_id ?? data.listId, schema);
    }
  }

  if (Array.isArray(data.schema)) {
    return buildSchemaFromRaw(data.list_id ?? data.listId, data.schema);
  }

  if (Array.isArray(data.columns)) {
    return buildSchemaFromRaw(data.list_id ?? data.listId, data.columns);
  }

  throw new Error("Schema file missing expected schema/columns list");
}

export function buildSchemaIndex(schema: ListSchema): SchemaIndex {
  const byId = new Map<string, ListColumn>();
  const byKey = new Map<string, ListColumn>();
  const byName = new Map<string, ListColumn>();

  for (const column of schema.columns) {
    byId.set(column.id, column);
    if (column.key) {
      byKey.set(column.key.toLowerCase(), column);
    }
    byName.set(column.name.toLowerCase(), column);
  }

  return { schema, byId, byKey, byName };
}

export function resolveColumn(
  index: SchemaIndex,
  identifier: string
): ListColumn | undefined {
  if (index.byId.has(identifier)) {
    return index.byId.get(identifier);
  }

  const key = identifier.toLowerCase();
  if (index.byKey.has(key)) {
    return index.byKey.get(key);
  }

  if (index.byName.has(key)) {
    return index.byName.get(key);
  }

  return undefined;
}

export function findColumnByType(index: SchemaIndex, types: ColumnType[]): ListColumn | undefined {
  return index.schema.columns.find((column) => types.includes(column.type));
}

export function findColumnByKeyOrName(
  index: SchemaIndex,
  candidates: string[]
): ListColumn | undefined {
  for (const candidate of candidates) {
    const column = resolveColumn(index, candidate);
    if (column) {
      return column;
    }
  }

  return undefined;
}

export function findPrimaryTextColumn(index: SchemaIndex): ListColumn | undefined {
  const primary = index.schema.columns.find((column) => column.is_primary_column);
  if (primary) {
    return primary;
  }

  const textColumn = index.schema.columns.find((column) =>
    ["text", "rich_text"].includes(column.type)
  );

  if (textColumn) {
    return textColumn;
  }

  return findColumnByKeyOrName(index, ["name", "title", "task"]);
}

export function inferSchemaFromItems(listId: string, items: unknown[]): ListSchema {
  const columns: ListColumn[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const fields = (item as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) {
      continue;
    }

    for (const field of fields) {
      if (!field || typeof field !== "object") {
        continue;
      }
      const fieldObj = field as Record<string, unknown>;
      const columnId = String(fieldObj.column_id ?? fieldObj.columnId ?? "");
      if (!columnId || seen.has(columnId)) {
        continue;
      }

      seen.add(columnId);
      const key = typeof fieldObj.key === "string" ? fieldObj.key : undefined;
      const name = key ?? columnId;
      columns.push({
        id: columnId,
        key,
        name,
        type: inferColumnType(fieldObj)
      });
    }
  }

  return { list_id: listId, columns };
}

function buildSchemaFromRaw(listId: unknown, rawColumns: unknown): ListSchema {
  if (!Array.isArray(rawColumns)) {
    throw new Error("Schema columns must be an array");
  }

  const list_id = typeof listId === "string" ? listId : "";
  const columns: ListColumn[] = rawColumns.map((column) => normalizeColumn(column));

  return { list_id, columns };
}

function normalizeColumn(column: unknown): ListColumn {
  if (!column || typeof column !== "object") {
    throw new Error("Invalid column entry in schema");
  }

  const raw = column as Record<string, unknown>;
  const id = String(raw.id ?? raw.column_id ?? raw.columnId ?? "");
  if (!id) {
    throw new Error("Schema column missing id/column_id");
  }

  const name = typeof raw.name === "string" ? raw.name : id;
  const key = typeof raw.key === "string" ? raw.key : undefined;
  const type = normalizeColumnType(raw.type);
  const is_primary_column = Boolean(raw.is_primary_column);
  const options = typeof raw.options === "object" ? (raw.options as ListColumn["options"]) : undefined;

  return { id, key, name, type, is_primary_column, options };
}

function normalizeColumnType(type: unknown): ColumnType {
  if (typeof type !== "string") {
    return "unknown";
  }

  const value = type.toLowerCase();
  const allowed: ColumnType[] = [
    "text",
    "rich_text",
    "number",
    "rating",
    "date",
    "user",
    "channel",
    "select",
    "checkbox",
    "currency",
    "url",
    "emoji",
    "attachment",
    "link",
    "message",
    "reference",
    "todo_assignee",
    "todo_due_date",
    "todo_completed"
  ];

  if (allowed.includes(value as ColumnType)) {
    return value as ColumnType;
  }

  return "unknown";
}

function inferColumnType(field: Record<string, unknown>): ColumnType {
  const typeHints: Array<[string, ColumnType]> = [
    ["rich_text", "rich_text"],
    ["text", "text"],
    ["user", "user"],
    ["select", "select"],
    ["date", "date"],
    ["rating", "rating"],
    ["checkbox", "checkbox"],
    ["link", "link"],
    ["attachment", "attachment"],
    ["message", "message"],
    ["reference", "reference"],
    ["channel", "channel"],
    ["emoji", "emoji"]
  ];

  for (const [key, type] of typeHints) {
    if (key in field) {
      return type;
    }
  }

  return "unknown";
}
