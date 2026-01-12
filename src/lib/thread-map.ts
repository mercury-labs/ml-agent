import { promises as fs } from "fs";
import path from "path";

import { resolveThreadMapPath } from "./config";

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

async function loadThreadMap(): Promise<ThreadMap> {
  const filePath = resolveThreadMapPath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ThreadMap;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
