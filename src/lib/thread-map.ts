import { promises as fs } from "fs";
import path from "path";

import { resolveThreadMapPath } from "./config";
import os from "os";

export type ThreadEntry = {
  permalink?: string;
  channel?: string;
  ts?: string;
};

type ThreadMap = {
  lists?: Record<string, Record<string, ThreadEntry>>;
};

export async function getThreadEntry(listId: string, itemId: string): Promise<ThreadEntry | null> {
  const map = await loadThreadMap();
  const entry = map.lists?.[listId]?.[itemId];
  return entry ?? null;
}

export async function setThreadEntry(listId: string, itemId: string, entry: ThreadEntry): Promise<void> {
  const filePath = resolveThreadMapPath();
  const map = await loadThreadMap();
  if (!map.lists) {
    map.lists = {};
  }
  if (!map.lists[listId]) {
    map.lists[listId] = {};
  }
  map.lists[listId][itemId] = {
    ...(map.lists[listId][itemId] ?? {}),
    ...entry
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
}

export async function removeThreadEntry(listId: string, itemId: string): Promise<void> {
  const filePath = resolveThreadMapPath();
  const map = await loadThreadMap();
  if (!map.lists?.[listId]?.[itemId]) {
    return;
  }
  delete map.lists[listId][itemId];
  if (Object.keys(map.lists[listId]).length === 0) {
    delete map.lists[listId];
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
}

async function loadThreadMap(): Promise<ThreadMap> {
  const filePath = resolveThreadMapPath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ThreadMap;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      const legacyPath = path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "slack-lists-cli",
        "threads.json"
      );
      try {
        const raw = await fs.readFile(legacyPath, "utf-8");
        return JSON.parse(raw) as ThreadMap;
      } catch (legacyError) {
        const legacyCode = (legacyError as { code?: string }).code;
        if (legacyCode === "ENOENT") {
          return {};
        }
        throw legacyError;
      }
    }
    throw error;
  }
}
