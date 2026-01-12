import { SlackListsClient } from "./slack-client";

const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();
let cachedUsers: Array<Record<string, unknown>> | null = null;
let cachedChannels: Array<Record<string, unknown>> | null = null;

export async function resolveUserId(client: SlackListsClient, input: string): Promise<string> {
  const trimmed = input.trim();

  if (userCache.has(trimmed)) {
    return userCache.get(trimmed)!;
  }

  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/);
  if (mentionMatch) {
    userCache.set(trimmed, mentionMatch[1]);
    return mentionMatch[1];
  }

  if (/^[UW][A-Z0-9]+$/.test(trimmed)) {
    userCache.set(trimmed, trimmed);
    return trimmed;
  }

  if (trimmed.includes("@") && !trimmed.startsWith("@")) {
    try {
      const result = await client.usersLookupByEmail({ email: trimmed });
      const user = (result as { user?: { id?: string } }).user;
      if (user?.id) {
        userCache.set(trimmed, user.id);
        return user.id;
      }
    } catch {
      // fallback to users.list
    }
  }

  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!cachedUsers) {
    cachedUsers = await loadUsers(client);
  }

  const found = cachedUsers.find((user) => matchUserName(user, name));
  if (found) {
    const id = String(found.id);
    userCache.set(trimmed, id);
    return id;
  }

  throw new Error(`Unable to resolve user: ${input}`);
}

export async function resolveChannelId(client: SlackListsClient, input: string): Promise<string> {
  const trimmed = input.trim();
  if (channelCache.has(trimmed)) {
    return channelCache.get(trimmed)!;
  }

  const mentionMatch = trimmed.match(/^<#([A-Z0-9]+)>$/);
  if (mentionMatch) {
    channelCache.set(trimmed, mentionMatch[1]);
    return mentionMatch[1];
  }

  if (/^[CGD][A-Z0-9]+$/.test(trimmed)) {
    channelCache.set(trimmed, trimmed);
    return trimmed;
  }

  const name = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!cachedChannels) {
    cachedChannels = await loadChannels(client);
  }

  const found = cachedChannels.find((channel) =>
    typeof channel.name === "string" && channel.name.toLowerCase() === name.toLowerCase()
  );

  if (found) {
    const id = String(found.id);
    channelCache.set(trimmed, id);
    return id;
  }

  throw new Error(`Unable to resolve channel: ${input}`);
}

export function parseMessageUrl(url: string): { channel: string; ts: string } | null {
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10,})/);
  if (!match) {
    return null;
  }

  const channel = match[1];
  const raw = match[2];
  if (raw.length <= 6) {
    return null;
  }

  const ts = `${raw.slice(0, -6)}.${raw.slice(-6)}`;
  return { channel, ts };
}

export function parseListUrl(url: string): { listId: string } | null {
  const match = url.match(/\/lists\/[A-Z0-9]+\/([A-Z0-9]+)/i);
  if (!match) {
    return null;
  }

  const listId = match[1];
  return { listId };
}

async function loadUsers(client: SlackListsClient): Promise<Array<Record<string, unknown>>> {
  const users: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = undefined;

  do {
    const result = await client.usersList({ limit: 200, cursor });
    const page = (result as { members?: Array<Record<string, unknown>> }).members ?? [];
    users.push(...page);
    cursor = (result as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;
  } while (cursor);

  return users;
}

async function loadChannels(client: SlackListsClient): Promise<Array<Record<string, unknown>>> {
  const channels: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = undefined;

  do {
    const result = await client.conversationsList({
      limit: 200,
      cursor,
      types: "public_channel,private_channel"
    });
    const page = (result as { channels?: Array<Record<string, unknown>> }).channels ?? [];
    channels.push(...page);
    cursor = (result as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;
  } while (cursor);

  return channels;
}

function matchUserName(user: Record<string, unknown>, name: string): boolean {
  const candidate = name.toLowerCase();
  const username = typeof user.name === "string" ? user.name.toLowerCase() : "";
  if (username === candidate) {
    return true;
  }

  const profile = user.profile as Record<string, unknown> | undefined;
  const display = typeof profile?.display_name === "string" ? profile.display_name.toLowerCase() : "";
  const real = typeof profile?.real_name === "string" ? profile.real_name.toLowerCase() : "";
  return display === candidate || real === candidate;
}
