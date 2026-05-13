import { Server } from '@hocuspocus/server';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import {
  type ConnectionDraft,
  extractConnectionsFromYDoc,
  normalizeTagSlug,
} from '@markdawn/shared/yjs-helpers';
import { Client, type Pool, type PoolClient } from 'pg';
import * as Y from 'yjs';
import { parseCookies } from './utils';

const META_ROOM_PREFIX = 'workspace-meta:';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractTitle(doc: Y.Doc): string {
  const titleText = doc.getText('title');
  return titleText.toString() || 'Untitled';
}

function isMetaRoom(documentName: string): boolean {
  return documentName.startsWith(META_ROOM_PREFIX);
}

type PageLookupRow = {
  id: string;
  title: string;
};

type PageContextRow = {
  workspace_id: string;
  properties: unknown;
};

type IndexedConnection = Omit<ConnectionDraft, 'targetId'> & {
  targetId: string | null;
  occurrenceCount: number;
};

async function updateWorkspaceMeta(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
): Promise<void> {
  try {
    const pageResult = await pool.query(
      'select workspace_id, title, icon, parent_id, position from pages where id = $1',
      [pageId],
    );
    if (pageResult.rows.length === 0) return;

    const page = pageResult.rows[0] as {
      workspace_id: string;
      title: string;
      icon: string | null;
      parent_id: string | null;
      position: string;
    };
    const metaRoomName = `${META_ROOM_PREFIX}${page.workspace_id}`;

    const connection = await hocuspocus.openDirectConnection(metaRoomName, {});
    try {
      await connection.transact((metaDoc: Y.Doc) => {
        const pageIndex = metaDoc.getMap('pageIndex');
        pageIndex.set(pageId, {
          title: page.title,
          icon: page.icon,
          parentId: page.parent_id,
          position: page.position,
        });
      });
    } finally {
      await connection.disconnect();
    }
  } catch (err) {
    logger.error(`[meta] failed to update meta for page ${pageId}: ${err}`);
  }
}

function extractPropertyTags(properties: unknown): ConnectionDraft[] {
  if (!properties || typeof properties !== 'object') return [];
  const tagsValue = (properties as Record<string, unknown>).tags;
  const rawTags = Array.isArray(tagsValue)
    ? tagsValue
    : typeof tagsValue === 'string'
      ? tagsValue.split(',')
      : [];

  return rawTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => normalizeTagSlug(tag))
    .filter(Boolean)
    .map((tag) => ({
      targetType: 'tag',
      targetSlug: tag,
      targetLabel: tag,
      connectionType: 'tag',
      linkText: tag,
    }));
}

function connectionKey(connection: ConnectionDraft): string {
  return [
    connection.targetType,
    connection.targetSlug,
    connection.connectionType,
    connection.targetId ?? '',
  ].join('\u001f');
}

function aggregateConnections(connections: ConnectionDraft[]): IndexedConnection[] {
  const byKey = new Map<string, IndexedConnection>();

  for (const connection of connections) {
    const key = connectionKey(connection);
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }

    const indexed: IndexedConnection = {
      ...connection,
      targetId: connection.targetId ?? null,
      occurrenceCount: 1,
    };
    byKey.set(key, indexed);
  }

  return [...byKey.values()];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function resolvePageTargets(
  client: PoolClient,
  workspaceId: string,
  connections: IndexedConnection[],
  staleTargets?: Map<string, string>,
): Promise<void> {
  const ids = [
    ...new Set(
      connections
        .filter((connection) => connection.targetType === 'page' && connection.targetId)
        .map((connection) => connection.targetId)
        .filter((id): id is string => typeof id === 'string' && isUuid(id))
        .concat(
          // Include stale targetIds so they are pre-fetched for fallback resolution.
          // This covers the case where the target page was renamed: the slug from
          // the wiki link content still points to the old slug, but the stale
          // targetId gives us the actual page UUID to look up.
          ...(staleTargets
            ? [...staleTargets.values()].filter((id): id is string => !!id && isUuid(id))
            : []),
        ),
    ),
  ];
  const slugs = [
    ...new Set(
      connections
        .filter((connection) => connection.targetType === 'page' && !connection.targetId)
        .map((connection) => connection.targetSlug)
        .filter(Boolean),
    ),
  ];

  const byId = new Map<string, PageLookupRow>();
  const bySlug = new Map<string, PageLookupRow>();

  if (ids.length > 0) {
    const result = await client.query<PageLookupRow>(
      `select id, title from pages
       where workspace_id = $1 and id = any($2::uuid[]) and is_deleted = false`,
      [workspaceId, ids],
    );
    for (const row of result.rows) {
      byId.set(row.id, row);
    }
  }

  if (slugs.length > 0) {
    const result = await client.query<PageLookupRow>(
      `select id, title from pages
       where workspace_id = $1 and lower(title) = any($2::text[]) and is_deleted = false`,
      [workspaceId, slugs],
    );
    for (const row of result.rows) {
      bySlug.set(row.title.toLowerCase(), row);
    }
  }

  for (const connection of connections) {
    if (connection.targetType !== 'page') continue;

    const byIdMatch = connection.targetId ? byId.get(connection.targetId) : undefined;
    if (byIdMatch) {
      connection.targetLabel = byIdMatch.title;
      continue;
    }

    const bySlugMatch = bySlug.get(connection.targetSlug);
    if (bySlugMatch) {
      connection.targetId = bySlugMatch.id;
      connection.targetLabel = bySlugMatch.title;
      continue;
    }

    // Fallback to stale targetId when slug resolution fails.
    // This handles the case where the target page was renamed after the
    // connection was created — the slug from the wiki link content still
    // carries the old slug, but the stale targetId maps it to the actual
    // page UUID. The byId map then resolves it to the updated page title.
    if (staleTargets) {
      const staleId = staleTargets.get(connection.targetSlug);
      if (staleId) {
        connection.targetId = staleId;
        const staleMatch = byId.get(staleId);
        if (staleMatch) {
          connection.targetLabel = staleMatch.title;
        }
      }
    }
  }

  // Batch last-resort cross-table slug lookup. Collect all slugs that
  // remain unresolved (no targetId and not found by title or stale mapping)
  // and query the connections table once instead of N separate queries.
  const unresolvedSlugs = [
    ...new Set(
      connections.filter((c) => c.targetType === 'page' && !c.targetId).map((c) => c.targetSlug),
    ),
  ];
  const slugTargetMap = new Map<string, string>();
  if (unresolvedSlugs.length > 0) {
    const crossResult = await client.query<{ target_slug: string; target_id: string }>(
      `select distinct on (target_slug) target_slug, target_id from connections
       where workspace_id = $1 and target_slug = any($2::text[]) and target_id is not null
       order by target_slug, updated_at desc`,
      [workspaceId, unresolvedSlugs],
    );
    for (const row of crossResult.rows) {
      slugTargetMap.set(row.target_slug, row.target_id);
    }
  }

  for (const connection of connections) {
    if (connection.targetType !== 'page' || connection.targetId) continue;
    const cid = slugTargetMap.get(connection.targetSlug);
    if (cid) {
      connection.targetId = cid;
      const pageMatch = byId.get(cid);
      if (pageMatch) {
        connection.targetLabel = pageMatch.title;
      }
    }
  }
}

async function updateConnections(
  client: PoolClient,
  pageId: string,
  ydocUpdate: Uint8Array,
  logger: Logger,
): Promise<string[]> {
  const pageResult = await client.query<PageContextRow>(
    'select workspace_id, properties from pages where id = $1',
    [pageId],
  );
  const page = pageResult.rows[0];
  if (!page) {
    logger.warn(`[connections] page ${pageId} not found, skipping connection update`);
    return [];
  }

  // Capture existing targetId mappings before deletion, so we can fall back
  // to them when slug-based resolution fails (e.g., after a target page rename).
  const existingResult = await client.query<{
    target_slug: string;
    target_id: string | null;
  }>(
    `select target_slug, target_id from connections
     where source_type = 'page' and source_id = $1 and target_type = 'page'`,
    [pageId],
  );
  const staleTargets = new Map<string, string>();
  for (const row of existingResult.rows) {
    if (row.target_slug && row.target_id && !staleTargets.has(row.target_slug)) {
      staleTargets.set(row.target_slug, row.target_id);
    }
  }

  const extracted = extractConnectionsFromYDoc(ydocUpdate);
  const propertyTags = extractPropertyTags(page.properties);
  const indexedConnections = aggregateConnections([...extracted, ...propertyTags]);
  await resolvePageTargets(client, page.workspace_id, indexedConnections, staleTargets);

  await client.query('delete from connections where source_type = $1 and source_id = $2', [
    'page',
    pageId,
  ]);

  for (const connection of indexedConnections) {
    const insertResult = await client.query<{ id: string }>(
      `insert into connections (
         workspace_id, source_type, source_id, target_type, target_id, target_slug,
         target_label, connection_type, link_text, link_context, occurrence_count, updated_at
       )
       values ($1, 'page', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       returning id`,
      [
        page.workspace_id,
        pageId,
        connection.targetType,
        connection.targetId,
        connection.targetSlug,
        connection.targetLabel,
        connection.connectionType,
        connection.linkText ?? null,
        connection.linkContext ?? null,
        connection.occurrenceCount,
      ],
    );

    const connectionId = insertResult.rows[0]?.id;
    if (!connectionId || !connection.linkContext) continue;

    await client.query(
      `insert into connection_occurrences (connection_id, context)
       values ($1, $2)`,
      [connectionId, connection.linkContext],
    );
  }

  logger.debug(`[connections] updated ${indexedConnections.length} connections for page ${pageId}`);

  // Return the resolved target page IDs so the caller can notify the
  // meta room — every target's backlinks panel needs to refetch.
  return indexedConnections
    .filter(
      (c): c is IndexedConnection & { targetId: string } => c.targetType === 'page' && !!c.targetId,
    )
    .map((c) => c.targetId);
}

async function updateBacklinksVersion(
  hocuspocus: Hocuspocus,
  workspaceId: string,
  pageIds: string[],
  logger: Logger,
): Promise<void> {
  if (pageIds.length === 0) return;

  const metaRoomName = `${META_ROOM_PREFIX}${workspaceId}`;
  try {
    const conn = await hocuspocus.openDirectConnection(metaRoomName, {});
    try {
      await conn.transact((metaDoc: Y.Doc) => {
        const bv = metaDoc.getMap('backlinksVersion');
        const now = Date.now();
        for (const id of pageIds) {
          bv.set(id, now);
        }
      });
    } finally {
      await conn.disconnect();
    }
  } catch (err) {
    logger.warn(`[meta] failed to update backlinksVersion for workspace ${workspaceId}: ${err}`);
  }
}

async function persistDocument(
  pool: Pool,
  hocuspocus: Hocuspocus,
  documentName: string,
  state: Uint8Array,
  sourceDoc: Y.Doc,
  logger: Logger,
  attempt = 1,
) {
  const client = await pool.connect();
  let workspaceId: string | undefined;
  let targetPageIds: string[] = [];

  try {
    await client.query('BEGIN');

    // Read title from the Yjs doc inside the transaction so we capture the
    // latest state — the doc could have been mutated between function entry
    // and here by the pg_notify handler (which updates the in-memory doc).
    const titleFieldExisted = sourceDoc.share.has('title');
    const title = extractTitle(sourceDoc);

    if (titleFieldExisted) {
      // Only update the pages.title column when the extracted title is
      // meaningful. This prevents auto-created empty title types (e.g. when a
      // page was imported via markdown without a Y.Doc title field) from
      // overwriting the real title with 'Untitled'. The Y.Doc binary is always
      // saved regardless so the title can be recovered on next load.
      const hasMeaningfulTitle = title !== 'Untitled';
      if (hasMeaningfulTitle) {
        await client.query(
          "update pages set ydoc = $1, title = $2, title_search = to_tsvector('english', $2), updated_at = NOW() where id = $3",
          [state, title, documentName],
        );
      } else {
        await client.query('update pages set ydoc = $1, updated_at = NOW() where id = $2', [
          state,
          documentName,
        ]);
      }
    } else {
      await client.query('update pages set ydoc = $1, updated_at = NOW() where id = $2', [
        state,
        documentName,
      ]);
    }
    targetPageIds = await updateConnections(client, documentName, state, logger);

    // Read workspace_id to know which meta room to notify.
    const wsResult = await client.query<{ workspace_id: string }>(
      'select workspace_id from pages where id = $1',
      [documentName],
    );
    workspaceId = wsResult.rows[0]?.workspace_id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');

    // Retry on PostgreSQL deadlock (40P01). The transaction was rolled back
    // by the server, so a fresh attempt with exponential backoff is safe.
    const pgErr = err as { code?: string } | undefined;
    if (pgErr?.code === '40P01' && attempt < 3) {
      logger.warn(`[persist] deadlock on page ${documentName}, retrying (attempt ${attempt})`);
      const delay = Math.min(50 * 2 ** attempt, 500);
      await new Promise((r) => setTimeout(r, delay));
      return persistDocument(pool, hocuspocus, documentName, state, sourceDoc, logger, attempt + 1);
    }

    logger.error(`[persist] failed for page ${documentName}: ${err}`);
    throw err;
  } finally {
    client.release();
  }

  updateWorkspaceMeta(hocuspocus, pool, documentName, logger);

  // Notify all affected pages that their backlinks may have changed.
  const affectedIds = [...new Set([documentName, ...targetPageIds])];
  if (workspaceId) {
    updateBacklinksVersion(hocuspocus, workspaceId, affectedIds, logger);
  }
}

export interface CollabServerConfig {
  port: number;
  pool: Pool;
  logger: Logger;
  debounceMs?: number;
  maxDebounceMs?: number;
  databaseUrl?: string;
}

export function createCollabServer(config: CollabServerConfig) {
  const { port, pool, logger, debounceMs = 500, maxDebounceMs = 3000 } = config;

  async function assertPageAccess(documentName: string, userId: string): Promise<void> {
    const access = await pool.query(
      `SELECT 1 FROM pages p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
       WHERE p.id = $1 AND wm.user_id = $2
       LIMIT 1`,
      [documentName, userId],
    );
    if (access.rows.length === 0) {
      logger.debug(`[auth] user=${userId} denied access to page=${documentName}`);
      throw new Error('Forbidden');
    }
  }

  async function assertWorkspaceAccess(workspaceId: string, userId: string): Promise<void> {
    const access = await pool.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
      [workspaceId, userId],
    );
    if (access.rows.length === 0) {
      logger.debug(`[auth] user=${userId} denied access to workspace=${workspaceId}`);
      throw new Error('Forbidden');
    }
  }

  const server = new Server({
    port,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: async ({ token, requestHeaders, documentName }) => {
      const cookies = parseCookies(requestHeaders.cookie);
      const bearerTokenHeader = requestHeaders.authorization;
      const bearerMatch = bearerTokenHeader?.match(/^Bearer\s+(.+)$/i);
      const bearerToken = bearerMatch?.[1]?.trim() ?? '';
      const tokenFromParam = token?.trim() ?? '';
      const tokenFromCookie =
        cookies.get('better-auth.session_token')?.trim() ||
        cookies.get('__Secure-better-auth.session_token')?.trim() ||
        '';
      const sessionToken = tokenFromParam || bearerToken || tokenFromCookie || '';

      if (!sessionToken) {
        logger.debug('[auth] no session token provided');
        throw new Error('Unauthorized');
      }

      const result = await pool.query(
        `select users.id, users.email, users.name, users.avatar_url as "avatarUrl"
         from sessions
         join users on users.id = sessions.user_id
         where sessions.token = $1 and sessions.expires_at > NOW()
         limit 1`,
        [sessionToken],
      );

      const user = result.rows[0] as
        | { id: string; email: string; name: string; avatarUrl: string | null }
        | undefined;
      if (!user) {
        logger.debug('[auth] invalid/expired session');
        throw new Error('Unauthorized');
      }

      if (documentName) {
        if (isMetaRoom(documentName)) {
          const workspaceId = documentName.slice(META_ROOM_PREFIX.length);
          await assertWorkspaceAccess(workspaceId, user.id);
        } else if (UUID_REGEX.test(documentName)) {
          const pageExists = await pool.query('SELECT 1 FROM pages WHERE id = $1 LIMIT 1', [
            documentName,
          ]);
          if (pageExists.rows.length > 0) {
            await assertPageAccess(documentName, user.id);
          }
        }
      }

      logger.info(`[auth] authenticated user=${user.id} (${user.email})`);
      return { user };
    },
    onLoadDocument: async ({ documentName, document, context }) => {
      if (isMetaRoom(documentName)) {
        const workspaceId = documentName.slice(META_ROOM_PREFIX.length);
        logger.debug(`[meta] loading workspace meta: ${workspaceId}`);

        const result = await pool.query(
          'select id, title, icon, parent_id, position from pages where workspace_id = $1 and is_deleted = false order by position asc',
          [workspaceId],
        );

        const pageIndex = document.getMap('pageIndex');
        for (const row of result.rows as {
          id: string;
          title: string;
          icon: string | null;
          parent_id: string | null;
          position: string;
        }[]) {
          pageIndex.set(row.id, {
            title: row.title,
            icon: row.icon,
            parentId: row.parent_id,
            position: row.position,
          });
        }

        logger.debug(`[meta] loaded ${result.rows.length} pages for workspace ${workspaceId}`);
        return;
      }

      const user = (context as { user?: { id: string } } | undefined)?.user;
      if (!user) {
        throw new Error('Unauthorized');
      }

      if (!UUID_REGEX.test(documentName)) {
        logger.debug(`skipping non-meta, non-UUID room: ${documentName}`);
        return undefined;
      }

      const result = await pool.query('select ydoc, title from pages where id = $1', [
        documentName,
      ]);

      if (result.rows.length === 0) {
        logger.info(`New document: ${documentName}`);
        return undefined;
      }

      const row = result.rows[0] as { ydoc: Buffer | null; title: string } | undefined;
      if (!row?.ydoc || row.ydoc.length === 0) {
        return undefined;
      }

      logger.debug(`Loading document: ${documentName}, size: ${row.ydoc.length} bytes`);
      Y.applyUpdate(document, new Uint8Array(row.ydoc));

      // Reconcile the Yjs title with the SQL title. This handles renames
      // that happened via the PATCH API (sidebar/home) while the page was
      // not open in any editor session — the SQL column was updated, but
      // the Yjs binary still has the old title.
      const yjsTitle = document.getText('title').toString();
      if (yjsTitle !== row.title) {
        document.transact(() => {
          const titleText = document.getText('title');
          titleText.delete(0, titleText.length);
          titleText.insert(0, row.title);
        });
      }
    },
    onStoreDocument: async (data) => {
      const documentName = data.documentName;

      if (isMetaRoom(documentName)) {
        logger.debug(`[meta] skip persist for meta room: ${documentName}`);
        return;
      }

      const user = (data.context as { user?: { id: string } } | undefined)?.user;
      if (!user) {
        throw new Error('Unauthorized');
      }

      const state = Y.encodeStateAsUpdate(data.document);
      if (!state || state.length === 0) {
        logger.debug(`[persist] skipping empty state: ${documentName}`);
        return;
      }

      logger.info(`[persist] saving: "${documentName}", size: ${state.length} bytes`);
      try {
        await persistDocument(pool, server.hocuspocus, documentName, state, data.document, logger);
        logger.debug(`[persist] saved: ${documentName}`);
      } catch (err) {
        logger.error(`[persist] failed to save "${documentName}": ${err}`);
        throw err;
      }
    },
    onDisconnect: async ({ documentName, instance }) => {
      if (isMetaRoom(documentName)) return;

      const doc = instance.documents.get(documentName) as Y.Doc | undefined;
      if (!doc) return;

      const state = Y.encodeStateAsUpdate(doc);
      if (!state || state.length === 0) return;

      logger.info(`[disconnect] force saving: ${documentName}, ${state.length} bytes`);
      try {
        await persistDocument(pool, server.hocuspocus, documentName, state, doc, logger);
        logger.debug(`[disconnect] force saved: ${documentName}`);
      } catch (err) {
        logger.error(`[disconnect] force save failed for "${documentName}": ${err}`);
      }
    },
    extensions: [],
  });

  const listenUrl = config.databaseUrl;
  if (listenUrl) {
    let listenClient: Client | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let stopped = false;
    const MAX_RECONNECT_DELAY = 30000;

    async function handlePageRenamed(
      workspaceId: string,
      pageId: string,
      newTitle: string,
    ): Promise<void> {
      const metaRoomName = `${META_ROOM_PREFIX}${workspaceId}`;
      const conn = await server.hocuspocus.openDirectConnection(metaRoomName, {});
      try {
        await conn.transact((metaDoc: Y.Doc) => {
          const pageIndex = metaDoc.getMap('pageIndex');
          const existing = pageIndex.get(pageId) as
            | { title: string; icon: string | null; parentId: string | null; position: string }
            | undefined;
          if (existing) {
            pageIndex.set(pageId, { ...existing, title: newTitle });
          }

          metaDoc.getMap('backlinksVersion').set(pageId, Date.now());
        });
      } finally {
        await conn.disconnect();
      }

      // The meta room pageIndex update above is sufficient to keep the
      // sidebar in sync. We intentionally do NOT modify the active Y.Doc
      // for this page here. If the rename was initiated from the page editor,
      // the client already wrote to the Y.Doc via commitTitle -> WebSocket
      // sync. Modifying it again from pg_notify races with that sync and
      // causes CRDT merge duplication (e.g., "x" becomes "xx").
      // If the page is not open, onLoadDocument handles title reconciliation
      // when it is next opened.
      logger.debug(`[listen] updated meta for renamed page ${pageId} -> ${newTitle}`);
    }

    async function handlePageDeleted(workspaceId: string, pageId: string): Promise<void> {
      const metaRoomName = `${META_ROOM_PREFIX}${workspaceId}`;
      const conn = await server.hocuspocus.openDirectConnection(metaRoomName, {});
      try {
        await conn.transact((metaDoc: Y.Doc) => {
          metaDoc.getMap('pageIndex').delete(pageId);
          metaDoc.getMap('backlinksVersion').set(pageId, Date.now());
        });
      } finally {
        await conn.disconnect();
      }

      logger.debug(`[listen] removed deleted page ${pageId} from meta room`);
    }

    function scheduleReconnect() {
      if (stopped) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(connectListenClient, delay);
    }

    async function connectListenClient(): Promise<void> {
      if (stopped) return;

      // Clean up existing client if any
      if (listenClient) {
        try {
          listenClient.end();
        } catch {
          // ignore cleanup errors
        }
        listenClient = null;
      }

      try {
        const client = new Client({ connectionString: listenUrl });
        await client.connect();
        await client.query('LISTEN page_renamed');
        await client.query('LISTEN page_deleted');

        client.on('notification', (msg) => {
          try {
            const payload = JSON.parse(msg.payload ?? '{}') as {
              workspaceId?: string;
              pageId?: string;
              newTitle?: string;
            };
            const { workspaceId, pageId, newTitle } = payload;
            if (!workspaceId || !pageId) return;

            if (msg.channel === 'page_deleted') {
              void handlePageDeleted(workspaceId, pageId).catch((err) =>
                logger.error(`[listen] handlePageDeleted failed: ${err}`),
              );
            } else if (msg.channel === 'page_renamed' && newTitle) {
              void handlePageRenamed(workspaceId, pageId, newTitle).catch((err) =>
                logger.error(`[listen] handlePageRenamed failed: ${err}`),
              );
            }
          } catch (err) {
            logger.error(`[listen] failed to process notification: ${err}`);
          }
        });

        client.on('error', (err) => {
          logger.error(`[listen] client error: ${err.message}`);
          scheduleReconnect();
        });

        client.on('end', () => {
          logger.warn('[listen] client connection ended');
          scheduleReconnect();
        });

        listenClient = client;
        reconnectAttempts = 0;
        logger.info('[listen] subscribed to page_renamed and page_deleted');
      } catch (err) {
        logger.error(`[listen] connection failed: ${err}`);
        listenClient = null;
        scheduleReconnect();
      }
    }

    connectListenClient();

    // Clean up the listen client and reconnect timers when the server is
    // destroyed (e.g. graceful shutdown or test teardown). Without this,
    // the dangling pg.Client and its timers would leak and keep retrying.
    const origDestroy = server.destroy.bind(server);
    Object.defineProperty(server, 'destroy', {
      value() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (listenClient) {
          try {
            listenClient.end();
          } catch {
            // ignore cleanup errors
          }
          listenClient = null;
        }
        return origDestroy();
      },
      writable: true,
      configurable: true,
    });
  } else {
    logger.warn('[listen] DATABASE_URL not configured — pg_notify subscriptions disabled');
  }

  return server;
}
