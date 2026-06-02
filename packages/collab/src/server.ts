import type { Hocuspocus } from '@hocuspocus/server';
import { type Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import { getAnonymousName, type ShareEventPayload } from '@markdawn/shared';
import {
  type ConnectionDraft,
  extractConnectionsFromYDoc,
  normalizeTagSlug,
} from '@markdawn/shared/yjs-helpers';
import { Client, type Pool, type PoolClient } from 'pg';
import * as Y from 'yjs';
import { handleShareEvent } from './permission-handler';
import { parseCookies } from './utils';

const META_ROOM_PREFIX = 'page-meta:';
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
  created_by: string;
  properties: unknown;
};

type IndexedConnection = Omit<ConnectionDraft, 'targetId'> & {
  targetId: string | null;
  occurrenceCount: number;
};

async function updatePageMeta(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
): Promise<void> {
  try {
    const pageResult = await pool.query(
      'select created_by, title, icon, parent_id, position from pages where id = $1',
      [pageId],
    );
    if (pageResult.rows.length === 0) return;

    const page = pageResult.rows[0] as {
      created_by: string;
      title: string;
      icon: string | null;
      parent_id: string | null;
      position: string;
    };
    const metaRoomName = `${META_ROOM_PREFIX}${page.created_by}`;

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
  userId: string,
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
       where id = any($1::uuid[]) and is_deleted = false`,
      [ids],
    );
    for (const row of result.rows) {
      byId.set(row.id, row);
    }
  }

  if (slugs.length > 0) {
    const result = await client.query<PageLookupRow>(
      `select id, title from pages
       where created_by = $1 and lower(title) = any($2::text[]) and is_deleted = false`,
      [userId, slugs],
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
       where target_slug = any($1::text[]) and target_id is not null
       order by target_slug, updated_at desc`,
      [unresolvedSlugs],
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
    'select created_by, properties from pages where id = $1',
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
  await resolvePageTargets(client, page.created_by, indexedConnections, staleTargets);

  await client.query('delete from connections where source_type = $1 and source_id = $2', [
    'page',
    pageId,
  ]);

  for (const connection of indexedConnections) {
    const insertResult = await client.query<{ id: string }>(
      `insert into connections (
         source_type, source_id, target_type, target_id, target_slug,
         target_label, connection_type, link_text, link_context, occurrence_count, updated_at
       )
       values ('page', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       returning id`,
      [
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
  userId: string,
  pageIds: string[],
  logger: Logger,
): Promise<void> {
  if (pageIds.length === 0) return;

  const metaRoomName = `${META_ROOM_PREFIX}${userId}`;
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
    logger.warn(`[meta] failed to update backlinksVersion for user ${userId}: ${err}`);
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
  let createdBy: string | undefined;
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

    // Read created_by to know which meta room to notify.
    const userResult = await client.query<{ created_by: string }>(
      'select created_by from pages where id = $1',
      [documentName],
    );
    createdBy = userResult.rows[0]?.created_by;

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

  updatePageMeta(hocuspocus, pool, documentName, logger);

  // Notify all affected pages that their backlinks may have changed.
  const affectedIds = [...new Set([documentName, ...targetPageIds])];
  if (createdBy) {
    updateBacklinksVersion(hocuspocus, createdBy, affectedIds, logger);
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

  async function assertPageAccess(
    documentName: string,
    userId: string,
  ): Promise<{ permission: 'view' | 'edit' | 'admin' }> {
    const ownerResult = await pool.query(
      'SELECT created_by FROM pages WHERE id = $1 AND is_deleted = false LIMIT 1',
      [documentName],
    );
    const owner = ownerResult.rows[0] as { created_by?: string } | undefined;
    if (!owner) {
      logger.debug(`[auth] page=${documentName} not found`);
      throw new Error('Forbidden');
    }
    if (owner.created_by === userId) {
      return { permission: 'edit' };
    }

    const shareResult = await pool.query(
      `
        WITH RECURSIVE folder_ancestors AS (
          SELECT f.id, f.parent_id, f.is_access_restricted
          FROM pages p
          JOIN folders f ON f.id = p.parent_id
          WHERE p.id = $1
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.is_access_restricted
          FROM folders parent
          JOIN folder_ancestors child ON child.parent_id = parent.id
        ),
        restricted_check AS (
          SELECT EXISTS(SELECT 1 FROM folder_ancestors WHERE is_access_restricted = true) AS blocked
        )
        SELECT permission
        FROM (
          -- Direct email invites on the page
          SELECT permission, 1 AS src
          FROM shares s
          WHERE s.entity_type = 'page' AND s.entity_id = $1 AND s.recipient_user_id = $2
            AND (s.expires_at IS NULL OR s.expires_at > NOW())

          UNION ALL

          -- Email invites on ancestor folders
          SELECT permission, 2 AS src
          FROM shares s
          WHERE s.entity_type = 'folder' AND s.entity_id IN (SELECT id FROM folder_ancestors) AND s.recipient_user_id = $2
            AND (s.expires_at IS NULL OR s.expires_at > NOW())

          UNION ALL

          -- Link share on the page (if public)
          SELECT permission, 3 AS src
          FROM shares s
          WHERE s.entity_type = 'page' AND s.entity_id = $1 AND s.token IS NOT NULL
            AND (s.expires_at IS NULL OR s.expires_at > NOW())
            AND EXISTS (SELECT 1 FROM pages WHERE id = $1 AND is_public = true)

          UNION ALL

          -- Workspace membership (blocked if any ancestor folder is restricted)
          SELECT
            CASE WHEN wm.role = 'admin' THEN 'admin' ELSE 'edit' END,
            4 AS src
          FROM workspace_members wm
          JOIN pages p ON p.id = $1
          WHERE wm.workspace_owner_id = p.created_by AND wm.member_id = $2
            AND NOT (SELECT blocked FROM restricted_check)
        ) perms
        ORDER BY
          CASE permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
          src ASC
        LIMIT 1
      `,
      [documentName, userId],
    );

    if (shareResult.rows.length === 0) {
      logger.debug(`[auth] user=${userId} denied access to page=${documentName} (no share)`);
      throw new Error('Forbidden');
    }

    const rawPermission = shareResult.rows[0].permission;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(
        `[auth] user=${userId} denied access to page=${documentName} (invalid permission)`,
      );
      throw new Error('Forbidden');
    }
    return { permission: rawPermission };
  }

  async function assertMetaRoomAccess(userId: string, roomUserId: string): Promise<void> {
    if (userId !== roomUserId) {
      logger.debug(`[auth] user=${userId} denied access to meta room for user=${roomUserId}`);
      throw new Error('Forbidden');
    }
  }

  async function assertAnonymousPageAccess(
    documentName: string,
  ): Promise<{ permission: 'view' | 'edit' | 'admin' }> {
    const pageResult = await pool.query(
      'SELECT is_public FROM pages WHERE id = $1 AND is_deleted = false LIMIT 1',
      [documentName],
    );
    if (!pageResult.rows[0]?.is_public) {
      logger.debug(`[auth] anonymous denied: page ${documentName} is not public`);
      throw new Error('Forbidden');
    }

    const shareResult = await pool.query(
      "SELECT permission FROM shares WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [documentName],
    );
    const rawPermission = shareResult.rows[0]?.permission;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(`[auth] anonymous denied: page ${documentName} has invalid permission`);
      throw new Error('Forbidden');
    }
    return { permission: rawPermission };
  }

  async function handleWorkspaceEvent(
    action: 'member_removed' | 'role_changed',
    ownerId: string,
    memberId: string,
  ): Promise<void> {
    logger.debug(`[workspace] event: action=${action} owner=${ownerId} member=${memberId}`);

    // For removal or role change, find active documents owned by this user
    // and check if the affected member still has independent access
    if (!server.hocuspocus?.documents) {
      logger.debug(`[workspace] no active documents, skipping`);
      return;
    }

    let affectedCount = 0;
    for (const [pageId, doc] of server.hocuspocus.documents) {
      // Only process UUID documents (not meta rooms)
      if (!UUID_REGEX.test(pageId)) continue;

      // Check if this page is owned by the workspace owner
      const ownerCheck = await pool.query(
        'SELECT 1 FROM pages WHERE id = $1 AND created_by = $2 AND is_deleted = false LIMIT 1',
        [pageId, ownerId],
      );
      if (ownerCheck.rowCount === 0) continue;

      const ownerDoc = doc as Document | undefined;
      if (!ownerDoc) continue;

      const connections = ownerDoc.getConnections();
      for (const connection of connections) {
        const ctx = connection.context as
          | { user?: { id: string; isAnonymous?: boolean } }
          | undefined;
        if (!ctx?.user || ctx.user.id !== memberId) continue;

        // Check if the member still has independent access (direct invite or owner)
        const accessCheck = await pool.query(
          `SELECT 1 FROM shares WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2
             AND token IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
          [pageId, memberId],
        );

        if (accessCheck.rowCount === 0) {
          // No remaining access — revoke the connection
          connection.sendStateless(JSON.stringify({ type: 'share_event', action: 'revoke' }));
          connection.close({ code: 4401, reason: 'Workspace access revoked' });
          affectedCount++;
          logger.info(
            `[workspace] revoked workspace-only access for user=${memberId} on page=${pageId}`,
          );
        }
      }
    }

    logger.info(
      `[workspace] processed ${action} for owner=${ownerId}: ${affectedCount} connection(s) affected`,
    );
  }

  const server = new Server({
    port,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: async ({ token, requestHeaders, documentName, connectionConfig }) => {
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

      if (sessionToken.startsWith('anon:')) {
        const anonymousId = sessionToken.slice(5);
        if (!documentName || !UUID_REGEX.test(documentName)) {
          logger.debug('[auth] anonymous token requires valid document name');
          throw new Error('Forbidden');
        }

        const { permission } = await assertAnonymousPageAccess(documentName);
        const anonymousName = getAnonymousName(anonymousId);

        if (permission === 'view') {
          connectionConfig.readOnly = true;
        }

        logger.info(
          `[auth] anonymous user=${anonymousId} connected to page=${documentName} (permission=${permission})`,
        );
        return {
          user: {
            id: anonymousId,
            name: anonymousName,
            isAnonymous: true,
          },
          permission,
        };
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

      let permission: 'view' | 'edit' | 'admin' = 'edit';

      if (documentName) {
        if (isMetaRoom(documentName)) {
          const roomUserId = documentName.slice(META_ROOM_PREFIX.length);
          await assertMetaRoomAccess(user.id, roomUserId);
        } else if (UUID_REGEX.test(documentName)) {
          const pageExists = await pool.query('SELECT 1 FROM pages WHERE id = $1 LIMIT 1', [
            documentName,
          ]);
          if (pageExists.rows.length > 0) {
            const access = await assertPageAccess(documentName, user.id);
            permission = access.permission;
          }
        }
      }

      if (permission === 'view') {
        connectionConfig.readOnly = true;
      }

      logger.info(`[auth] authenticated user=${user.id} (${user.email}) permission=${permission}`);
      return { user, permission };
    },
    onLoadDocument: async ({ documentName, document, context }) => {
      if (isMetaRoom(documentName)) {
        const userId = documentName.slice(META_ROOM_PREFIX.length);
        logger.debug(`[meta] loading page meta for user: ${userId}`);

        const result = await pool.query(
          'select id, title, icon, parent_id, position from pages where created_by = $1 and is_deleted = false order by position asc',
          [userId],
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

        logger.debug(`[meta] loaded ${result.rows.length} pages for user ${userId}`);
        return;
      }

      const contextUser = (context as { user?: { id: string; isAnonymous?: boolean } } | undefined)
        ?.user;
      if (!contextUser) {
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

      const context = data.context as
        | { user?: { id: string; isAnonymous?: boolean }; permission?: string }
        | undefined;
      if (!context?.user) {
        throw new Error('Unauthorized');
      }

      if (context.user.isAnonymous && context.permission === 'view') {
        logger.debug(`[persist] skipping anonymous view-only user save for ${documentName}`);
        return;
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

    async function handlePageRenamed(pageId: string, newTitle: string): Promise<void> {
      // Look up the page creator to determine which meta room to update.
      const pageResult = await pool.query('select created_by from pages where id = $1', [pageId]);
      const createdBy = pageResult.rows[0]?.created_by as string | undefined;
      if (!createdBy) {
        logger.debug(`[listen] page ${pageId} not found, skipping rename`);
        return;
      }

      const metaRoomName = `${META_ROOM_PREFIX}${createdBy}`;
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

      // Push the rename to the active Y.Doc so open editors see sidebar/home
      // renames from other clients. Before pushing, delay briefly to let any
      // in-flight WebSocket sync from the editing client arrive first — if
      // it already wrote the new title, we skip to avoid CRDT merging two
      // identical writes into a duplicate (e.g., "x" becomes "xx").
      const activeDoc = server.hocuspocus.documents.get(pageId) as Y.Doc | undefined;
      if (activeDoc) {
        await new Promise((r) => setTimeout(r, 50));
        const beforeTitle = activeDoc.getText('title').toString();
        if (beforeTitle !== newTitle) {
          activeDoc.transact(() => {
            const titleText = activeDoc.getText('title');
            titleText.delete(0, titleText.length);
            titleText.insert(0, newTitle);
          });
          logger.debug(
            `[listen] pushed rename to active session for page ${pageId}: "${beforeTitle}" -> "${newTitle}"`,
          );
        }
      }

      logger.debug(`[listen] updated meta for renamed page ${pageId} -> ${newTitle}`);
    }

    async function handlePageDeleted(pageId: string): Promise<void> {
      // Look up the page creator to determine which meta room to update.
      const pageResult = await pool.query('select created_by from pages where id = $1', [pageId]);
      const createdBy = pageResult.rows[0]?.created_by as string | undefined;
      if (!createdBy) {
        logger.debug(`[listen] page ${pageId} not found, skipping delete`);
        return;
      }

      const metaRoomName = `${META_ROOM_PREFIX}${createdBy}`;
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
        await client.query('LISTEN share_event');
        await client.query('LISTEN workspace_event');

        client.on('notification', (msg) => {
          try {
            if (msg.channel === 'page_deleted') {
              const payload = JSON.parse(msg.payload ?? '{}') as { pageId?: string };
              if (!payload.pageId) return;
              void handlePageDeleted(payload.pageId).catch((err) =>
                logger.error(`[listen] handlePageDeleted failed: ${err}`),
              );
            } else if (msg.channel === 'page_renamed') {
              const payload = JSON.parse(msg.payload ?? '{}') as {
                pageId?: string;
                newTitle?: string;
              };
              if (!payload.pageId || !payload.newTitle) return;
              void handlePageRenamed(payload.pageId, payload.newTitle).catch((err) =>
                logger.error(`[listen] handlePageRenamed failed: ${err}`),
              );
            } else if (msg.channel === 'share_event') {
              logger.debug(`[listen] received share_event: ${msg.payload}`);
              const payload = JSON.parse(msg.payload ?? '{}') as ShareEventPayload;
              if (!payload.entityId) {
                logger.debug('[listen] share_event missing entityId, skipping');
                return;
              }
              void handleShareEvent(server, payload, pool, logger).catch((err) =>
                logger.error(`[listen] handleShareEvent failed: ${err}`),
              );
            } else if (msg.channel === 'workspace_event') {
              logger.debug(`[listen] received workspace_event: ${msg.payload}`);
              const payload = JSON.parse(msg.payload ?? '{}') as {
                type: string;
                action: string;
                ownerId: string;
                memberId: string;
              };
              if (!payload.ownerId || !payload.memberId) {
                logger.debug('[listen] workspace_event missing ownerId or memberId, skipping');
                return;
              }
              void handleWorkspaceEvent(
                payload.action as 'member_removed' | 'role_changed',
                payload.ownerId,
                payload.memberId,
              ).catch((err) => logger.error(`[listen] handleWorkspaceEvent failed: ${err}`));
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
        logger.info('[listen] subscribed to page_renamed, page_deleted, and share_event');
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
