import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import os from "os";

import { ListSchema } from "./types";
import { mergeSchemas } from "./schema";

const NEW_CACHE_DIR = "ml-agent";
const LEGACY_CACHE_DIR = "slack-lists-cli";

export function getCacheDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const primary = path.join(base, NEW_CACHE_DIR);
  if (existsSync(primary)) {
    return primary;
  }
  return primary;
}

function getLegacyCacheDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, LEGACY_CACHE_DIR);
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
      const legacyPath = path.join(getLegacyCacheDir(), "schemas", `${listId}.json`);
      try {
        const legacyRaw = await fs.readFile(legacyPath, "utf-8");
        return JSON.parse(legacyRaw) as ListSchema;
      } catch (legacyError) {
        const legacyCode = (legacyError as { code?: string }).code;
        if (legacyCode === "ENOENT") {
          return null;
        }
        throw legacyError;
      }
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
