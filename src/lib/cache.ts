import { promises as fs } from "fs";
import path from "path";
import os from "os";

import { ListSchema } from "./types";
import { mergeSchemas } from "./schema";

export function getCacheDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "slack-lists-cli");
}

export function getSchemaCachePath(listId: string): string {
  return path.join(getCacheDir(), "schemas", `${listId}.json`);
}

export async function loadCachedSchema(listId: string): Promise<ListSchema | null> {
  const filePath = getSchemaCachePath(listId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ListSchema;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveSchemaCache(listId: string, schema: ListSchema): Promise<void> {
  const filePath = getSchemaCachePath(listId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(schema, null, 2), "utf-8");
}

export async function updateSchemaCache(listId: string, schema: ListSchema): Promise<ListSchema> {
  const cached = await loadCachedSchema(listId);
  const merged = mergeSchemas(cached, schema);
  await saveSchemaCache(listId, merged);
  return merged;
}
