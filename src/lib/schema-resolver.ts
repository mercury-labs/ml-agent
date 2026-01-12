import { resolveSchemaPath } from "./config";
import { SlackListsClient } from "./slack-client";
import {
  buildSchemaIndex,
  inferSchemaFromItems,
  loadSchemaFromFile,
  normalizeSchema,
  SchemaIndex
} from "./schema";
import { loadCachedSchema, saveSchemaCache, updateSchemaCache } from "./cache";

export async function resolveSchemaIndex(
  client: SlackListsClient,
  listId: string,
  schemaPath?: string,
  refreshCache = false
): Promise<SchemaIndex | undefined> {
  const resolvedPath = resolveSchemaPath(schemaPath);
  if (resolvedPath) {
    const schema = await loadSchemaFromFile(resolvedPath);
    return buildSchemaIndex(schema);
  }

  if (!refreshCache) {
    const cached = await loadCachedSchema(listId);
    if (cached) {
      return buildSchemaIndex(cached);
    }
  }

  try {
    const result = await client.call("slackLists.info", { list_id: listId });
    if ((result as { ok?: boolean }).ok) {
      const schema = normalizeSchema(result as unknown as Record<string, unknown>);
      await saveSchemaCache(listId, schema);
      return buildSchemaIndex(schema);
    }
  } catch (error) {
    const slackError = (error as { data?: { error?: string } })?.data?.error;
    if (slackError !== "unknown_method") {
      throw error;
    }
  }

  try {
    const itemsResult = await client.call("slackLists.items.list", {
      list_id: listId,
      limit: 100
    });
    const items = (itemsResult as { items?: Record<string, unknown>[] }).items ?? [];

    const firstItemId = items[0]?.id;
    if (firstItemId) {
      try {
        const infoResult = await client.call("slackLists.items.info", {
          list_id: listId,
          id: firstItemId
        });
        const list = (infoResult as { list?: { list_metadata?: Record<string, unknown>; id?: string } }).list;
        if (list?.list_metadata) {
          const schema = normalizeSchema({
            list_metadata: list.list_metadata,
            list_id: list.id ?? listId
          });
          await saveSchemaCache(listId, schema);
          return buildSchemaIndex(schema);
        }
      } catch (error) {
        const slackError = (error as { data?: { error?: string } })?.data?.error;
        if (slackError && slackError !== "unknown_method") {
          throw error;
        }
      }
    }

    const inferred = inferSchemaFromItems(listId, items);
    if (inferred.columns.length === 0) {
      return undefined;
    }
    const merged = await updateSchemaCache(listId, inferred);
    return buildSchemaIndex(merged);
  } catch (error) {
    const slackError = (error as { data?: { error?: string } })?.data?.error;
    if (slackError !== "unknown_method") {
      throw error;
    }
  }

  return undefined;
}
