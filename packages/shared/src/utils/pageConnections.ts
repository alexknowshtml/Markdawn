import {
  type ConnectionDraft,
  extractConnectionsFromYDoc,
  normalizeTagSlug,
} from './yjs-helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IndexedPageConnection = Omit<ConnectionDraft, 'targetId'> & {
  targetId: string | null;
  occurrenceCount: number;
  occurrences: PageConnectionOccurrence[];
};

export type PageConnectionOccurrence = {
  context: string | null;
};

export function extractPropertyTagConnections(properties: unknown): ConnectionDraft[] {
  if (!properties || typeof properties !== 'object') return [];
  const tagsValue = (properties as Record<string, unknown>).tags;
  const rawTags = Array.isArray(tagsValue)
    ? tagsValue
    : typeof tagsValue === 'string'
      ? tagsValue.split(',')
      : [];

  return rawTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map(normalizeTagSlug)
    .filter(Boolean)
    .map((tag) => ({
      targetType: 'tag',
      targetSlug: tag,
      targetLabel: tag,
      connectionType: 'tag',
      linkText: tag,
    }));
}

/**
 * Extract the durable connection rows for a page before target access
 * resolution. Both API content replacement and collaboration persistence use
 * this exact aggregation so their indexes cannot drift.
 */
export function extractIndexedPageConnections(
  ydocUpdate: Uint8Array,
  properties: unknown,
): IndexedPageConnection[] {
  return aggregateIndexedPageConnections([
    ...(ydocUpdate.byteLength > 0 ? extractConnectionsFromYDoc(ydocUpdate) : []),
    ...extractPropertyTagConnections(properties),
  ]);
}

export function aggregateIndexedPageConnections(
  connections: readonly ConnectionDraft[],
): IndexedPageConnection[] {
  const byKey = new Map<string, IndexedPageConnection>();
  for (const connection of connections) {
    const targetId =
      connection.targetId && UUID_PATTERN.test(connection.targetId)
        ? connection.targetId.toLowerCase()
        : null;
    const key = [
      connection.targetType,
      connection.targetSlug,
      connection.connectionType,
      targetId ?? '',
    ].join('\u001f');
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      existing.occurrences.push({ context: connection.linkContext ?? null });
      continue;
    }
    byKey.set(key, {
      ...connection,
      targetId,
      occurrenceCount: 1,
      occurrences: [{ context: connection.linkContext ?? null }],
    });
  }
  return [...byKey.values()];
}
