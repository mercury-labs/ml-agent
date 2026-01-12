import { ColumnType, ListColumn } from "./types";
import { resolveChannelId, resolveUserId } from "./resolvers";
import { SlackListsClient } from "./slack-client";

export type FieldBuildContext = {
  client: SlackListsClient;
};

export type ParsedFieldInput =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "key"; key: string; value: string };

export function parseFieldArgument(input: string): ParsedFieldInput {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { kind: "json", value: JSON.parse(trimmed) as Record<string, unknown> };
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex === -1) {
    throw new Error(`Invalid field format: ${input}`);
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  const value = trimmed.slice(equalsIndex + 1).trim();
  if (!key) {
    throw new Error(`Invalid field key: ${input}`);
  }

  return { kind: "key", key, value };
}

export async function buildTypedField(
  column: ListColumn,
  rawValue: string,
  context: FieldBuildContext
): Promise<Record<string, unknown>> {
  switch (column.type) {
    case "text":
    case "rich_text":
      return { rich_text: buildRichText(rawValue) };
    case "user":
    case "todo_assignee":
      return { user: await resolveUsers(rawValue, context) };
    case "channel":
      return { channel: await resolveChannels(rawValue, context) };
    case "select":
      return { select: resolveSelectValues(column, rawValue) };
    case "date":
    case "todo_due_date":
      return { date: splitList(rawValue) };
    case "checkbox":
    case "todo_completed":
      return { checkbox: parseBoolean(rawValue) };
    case "number":
    case "currency": {
      const num = parseNumber(rawValue);
      return { number: [num] };
    }
    case "rating": {
      const num = parseNumber(rawValue);
      return { rating: [num] };
    }
    case "link":
      return { link: [buildLinkValue(rawValue)] };
    case "attachment":
      return { attachment: splitList(rawValue) };
    case "message":
      return { message: splitList(rawValue) };
    case "reference":
      return { reference: splitList(rawValue).map((id) => ({ file: { file_id: id } })) };
    default:
      return { rich_text: buildRichText(rawValue) };
  }
}

export function buildRichText(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text }]
        }
      ]
    }
  ];
}

export function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["true", "yes", "1", "completed", "done"].includes(normalized);
}

export function parseNumber(value: string): number {
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw new Error(`Expected a number, got: ${value}`);
  }
  return num;
}

export function resolveSelectValues(column: ListColumn, rawValue: string): string[] {
  const values = splitList(rawValue);
  const choices = column.options?.choices ?? [];
  if (choices.length === 0) {
    return values;
  }

  return values.map((value) => resolveSelectValue(choices, value));
}

function resolveSelectValue(choices: { value: string; label?: string }[], input: string): string {
  const normalized = input.toLowerCase();
  const match = choices.find(
    (choice) => choice.value.toLowerCase() === normalized || choice.label?.toLowerCase() === normalized
  );
  return match?.value ?? input;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolveUsers(value: string, context: FieldBuildContext): Promise<string[]> {
  const items = splitList(value);
  const resolved: string[] = [];
  for (const item of items) {
    resolved.push(await resolveUserId(context.client, item));
  }
  return resolved;
}

async function resolveChannels(value: string, context: FieldBuildContext): Promise<string[]> {
  const items = splitList(value);
  const resolved: string[] = [];
  for (const item of items) {
    resolved.push(await resolveChannelId(context.client, item));
  }
  return resolved;
}

function buildLinkValue(rawValue: string): Record<string, unknown> {
  const [url, label] = rawValue.split("|");
  const value: Record<string, unknown> = {
    original_url: url.trim()
  };
  if (label && label.trim().length > 0) {
    value.display_name = label.trim();
    value.display_as_url = false;
  } else {
    value.display_as_url = true;
  }
  return value;
}
