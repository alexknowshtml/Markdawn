import type { Hocuspocus } from '@hocuspocus/server';
import { type Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import {
  getAnonymousName,
  type ShareEventPayload,
  type StatelessShareMessage,
} from '@markdawn/shared';
import {
  type ConnectionDraft,
  extractConnectionsFromYDoc,
  normalizeTagSlug,
} from '@markdawn/shared/yjs-helpers';
import { Client, type Pool, type PoolClient } from 'pg';
import * as Y from 'yjs';
import { createCoalescingTaskQueue } from './coalescingTaskQueue';
import {
  handleShareEvent,
  handleWorkspaceEvent as handleWorkspaceEvent_,
  revalidateActivePageConnections,
} from './permission-handler';
import { parseCookies } from './utils';

const META_ROOM_PREFIX = 'page-meta:';
const SHARE_EVENT_QUEUE_LIMIT = 256;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CollabAccessError extends Error {
  readonly code = 'COLLAB_ACCESS_DENIED';

  constructor() {
    super('Forbidden');
    this.name = 'CollabAccessError';
  }
}

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

type PageMeta = {
  title: string;
  icon: string | null;
  parent_id: string | null;
  position: string;
};

type PageContextRow = {
  owner_id: string;
  properties: unknown;
};

type IndexedConnection = Omit<ConnectionDraft, 'targetId'> & {
  targetId: string | null;
  occurrenceCount: number;
};

/**
 * Payload received on the `share_event` pg_notify channel when a user receives
 * a new share invite. The collab server forwards this to the recipient's active
 * WebSocket connection so they see an invite notification toast.
 */
interface InviteReceivedPayload {
  type: 'invite_received';
  entityType: string;
  entityId: string;
  entityTitle: string;
  sharedByName: string;
  targetUserId: string;
  message?: string;
}

type ActiveMetaDocuments = Map<string, Document>;

function getActiveMetaDocuments(hocuspocus: Hocuspocus): ActiveMetaDocuments {
  const documents = new Map<string, Document>();
  for (const [documentName, document] of hocuspocus.documents) {
    if (!documentName.startsWith(META_ROOM_PREFIX)) continue;
    const userId = documentName.slice(META_ROOM_PREFIX.length);
    if (!UUID_REGEX.test(userId)) continue;
    documents.set(userId, document as Document);
  }
  return documents;
}

async function getPageMetaRecipients(
  pool: Pool,
  pageIds: string[],
  candidateUserIds: string[],
): Promise<Map<string, string[]>> {
  if (pageIds.length === 0 || candidateUserIds.length === 0) return new Map();

  const result = await pool.query<{ page_id: string; user_id: string }>(
    `with requested as (
       select unnest($1::uuid[]) as page_id
     ), active_users as (
       select unnest($2::uuid[]) as user_id
     ), recipients as (
       select requested.page_id, base.user_id
       from requested
       join lateral get_page_base_permissions(requested.page_id) base on true
       union
       select requested.page_id, pae.user_id
       from requested
       join page_access_events pae on pae.page_id = requested.page_id
       join lateral get_effective_page_permission(requested.page_id, pae.user_id) access on true
       where access.permission is not null
       union
       select requested.page_id, fae.user_id
       from requested
       join pages p on p.id = requested.page_id and p.is_deleted = false
       join folder_closure fc on fc.descendant_id = p.parent_id
       join folder_access_events fae on fae.folder_id = fc.ancestor_id
       join lateral get_effective_page_permission(requested.page_id, fae.user_id) access on true
       where access.permission is not null
     )
     select distinct recipients.page_id, recipients.user_id
     from recipients
     join active_users on active_users.user_id = recipients.user_id
     where recipients.user_id is not null`,
    [pageIds, candidateUserIds],
  );

  const recipients = new Map<string, string[]>();
  for (const row of result.rows) {
    const ids = recipients.get(row.page_id) ?? [];
    ids.push(row.user_id);
    recipients.set(row.page_id, ids);
  }
  return recipients;
}

async function getDeletedPageMetaRecipientIds(
  pool: Pool,
  pageId: string,
  candidateUserIds: string[],
): Promise<string[]> {
  if (candidateUserIds.length === 0) return [];

  const result = await pool.query<{ user_id: string }>(
    `with page_info as (
       select coalesce(
         (
           select root.created_by
           from folder_closure fc
           join folders root on root.id = fc.ancestor_id
           where fc.descendant_id = p.parent_id and root.parent_id is null
           order by fc.depth desc
           limit 1
         ),
         p.created_by
       ) as owner_id, p.parent_id
       from pages p where p.id = $1
     ), recipients as (
       select owner_id as user_id from page_info
       union
       select s.recipient_user_id
       from shares s
       where s.entity_type = 'page' and s.entity_id = $1
         and s.recipient_user_id is not null and s.token is null
         and (s.expires_at is null or s.expires_at > now())
       union
       select s.recipient_user_id
       from shares s
       join page_info pi on s.entity_id in (
         select ancestor_id from folder_closure where descendant_id = pi.parent_id
       )
       where s.entity_type = 'folder' and s.recipient_user_id is not null and s.token is null
         and (s.expires_at is null or s.expires_at > now())
       union
       select wm.member_id
       from workspace_members wm
       join page_info pi on pi.owner_id = wm.workspace_owner_id
       union
       select user_id from page_access_events where page_id = $1
       union
       select fae.user_id
       from folder_access_events fae
       join page_info pi on fae.folder_id in (
         select ancestor_id from folder_closure where descendant_id = pi.parent_id
       )
     )
     select distinct user_id
     from recipients
     where user_id is not null and user_id = any($2::uuid[])`,
    [pageId, candidateUserIds],
  );
  return result.rows.map((row) => row.user_id);
}

async function getDeletedFolderMetaRecipientIds(
  pool: Pool,
  folderId: string,
  candidateUserIds: string[],
): Promise<string[]> {
  if (candidateUserIds.length === 0) return [];

  const result = await pool.query<{ user_id: string }>(
    `with folder_info as (
       select coalesce(
         (
           select root.created_by
           from folder_closure fc
           join folders root on root.id = fc.ancestor_id
           where fc.descendant_id = f.id and root.parent_id is null
           order by fc.depth desc
           limit 1
         ),
         f.created_by
       ) as owner_id
       from folders f where f.id = $1
     ), related_folders as (
       select ancestor_id as folder_id from folder_closure where descendant_id = $1
       union
       select descendant_id as folder_id from folder_closure where ancestor_id = $1
     ), recipients as (
       select owner_id as user_id from folder_info
       union
       select s.recipient_user_id
       from shares s
       where s.entity_type = 'folder'
         and s.entity_id in (select folder_id from related_folders)
         and s.recipient_user_id is not null and s.token is null
         and (s.expires_at is null or s.expires_at > now())
       union
       select wm.member_id
       from workspace_members wm
       join folder_info fi on fi.owner_id = wm.workspace_owner_id
       union
       select fae.user_id
       from folder_access_events fae
       where fae.folder_id in (select folder_id from related_folders)
     )
     select distinct user_id
     from recipients
     where user_id is not null and user_id = any($2::uuid[])`,
    [folderId, candidateUserIds],
  );
  return result.rows.map((row) => row.user_id);
}

async function updatePageMeta(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
  knownPage?: PageMeta,
  knownRecipients?: Map<string, string[]>,
  knownActiveDocuments?: ActiveMetaDocuments,
): Promise<void> {
  const activeDocuments = knownActiveDocuments ?? getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) return;

  let page = knownPage;
  if (!page) {
    const pageResult = await pool.query<PageMeta>(
      'select title, icon, parent_id, position from pages where id = $1 and is_deleted = false',
      [pageId],
    );
    page = pageResult.rows[0];
  }
  if (!page) return;

  const recipients =
    knownRecipients ??
    (await getPageMetaRecipients(pool, [pageId], Array.from(activeDocuments.keys())));
  const failures: unknown[] = [];
  for (const recipientId of recipients.get(pageId) ?? []) {
    const metaDoc = activeDocuments.get(recipientId);
    if (!metaDoc) continue;
    try {
      metaDoc.transact(() => {
        const pageIndex = metaDoc.getMap('pageIndex');
        pageIndex.set(pageId, {
          title: page.title,
          icon: page.icon,
          parentId: page.parent_id,
          position: page.position,
        });
      });
    } catch (error) {
      failures.push(error);
      logger.error(
        `[meta] failed to update meta for user ${recipientId} on page ${pageId}: ${error}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to update page metadata for ${pageId}`);
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
  ownerId: string,
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
        .filter((connection) => connection.targetType === 'page')
        .map((connection) => connection.targetSlug)
        .filter(Boolean),
    ),
  ];

  const byId = new Map<string, PageLookupRow>();
  const bySlug = new Map<string, PageLookupRow>();

  if (ids.length > 0) {
    const result = await client.query<PageLookupRow>(
      `select id, title from pages
       where id = any($1::uuid[])
         and is_deleted = false
         and coalesce(get_root_folder_owner(parent_id), created_by) = $2`,
      [ids, ownerId],
    );
    for (const row of result.rows) {
      byId.set(row.id, row);
    }
  }

  const titleSlugs = slugs.filter((slug) => !slug.includes('/'));
  if (titleSlugs.length > 0) {
    const result = await client.query<PageLookupRow & { normalized_title: string }>(
      `select min(id::text) as id, min(title) as title, lower(trim(title)) as normalized_title
       from pages
       where coalesce(get_root_folder_owner(parent_id), created_by) = $1
         and lower(trim(title)) = any($2::text[])
         and is_deleted = false
       group by lower(trim(title))
       having count(*) = 1`,
      [ownerId, titleSlugs],
    );
    for (const row of result.rows) {
      bySlug.set(row.normalized_title, row);
    }
  }

  const pathSlugs = slugs.filter((slug) => slug.includes('/'));
  if (pathSlugs.length > 0) {
    const result = await client.query<PageLookupRow & { normalized_path: string }>(
      `with recursive folder_paths as (
         select f.id, lower(trim(f.name))::text as folder_path
         from folders f
         where f.parent_id is null and f.created_by = $1 and f.is_deleted = false
         union all
         select child.id,
                (parent.folder_path || '/' || lower(trim(child.name)))::text
         from folders child
         join folder_paths parent on parent.id = child.parent_id
         where child.is_deleted = false
       )
       select min(p.id::text) as id,
              min(p.title) as title,
              paths.folder_path || '/' || lower(trim(p.title)) as normalized_path
       from pages p
       join folder_paths paths on paths.id = p.parent_id
       where p.is_deleted = false
         and paths.folder_path || '/' || lower(trim(p.title)) = any($2::text[])
       group by paths.folder_path || '/' || lower(trim(p.title))
       having count(*) = 1`,
      [ownerId, pathSlugs],
    );
    for (const row of result.rows) {
      bySlug.set(row.normalized_path, row);
    }
  }

  for (const connection of connections) {
    if (connection.targetType !== 'page') continue;

    const byIdMatch = connection.targetId ? byId.get(connection.targetId) : undefined;
    if (byIdMatch) {
      connection.targetLabel = byIdMatch.title;
      continue;
    }

    // Never retain a client-provided target outside the source workspace.
    // Slug and stale-target resolution below may replace this with a target
    // that was returned by the workspace-scoped lookup.
    connection.targetId = null;

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
      const staleMatch = staleId ? byId.get(staleId) : undefined;
      if (staleId && staleMatch) {
        connection.targetId = staleId;
        connection.targetLabel = staleMatch.title;
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
    `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id, properties
     from pages where id = $1`,
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
  await resolvePageTargets(client, page.owner_id, indexedConnections, staleTargets);

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
  pool: Pool,
  pageIds: string[],
  logger: Logger,
  knownRecipients?: Map<string, string[]>,
  knownActiveDocuments?: ActiveMetaDocuments,
): Promise<void> {
  if (pageIds.length === 0) return;

  const activeDocuments = knownActiveDocuments ?? getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) return;

  const pageIdsByRecipient = new Map<string, string[]>();
  const recipientsByPage =
    knownRecipients ??
    (await getPageMetaRecipients(pool, pageIds, Array.from(activeDocuments.keys())));
  for (const pageId of pageIds) {
    for (const recipientId of recipientsByPage.get(pageId) ?? []) {
      const ids = pageIdsByRecipient.get(recipientId) ?? [];
      ids.push(pageId);
      pageIdsByRecipient.set(recipientId, ids);
    }
  }

  const failures: unknown[] = [];
  for (const [recipientId, recipientPageIds] of pageIdsByRecipient) {
    const metaDoc = activeDocuments.get(recipientId);
    if (!metaDoc) continue;
    try {
      metaDoc.transact(() => {
        const bv = metaDoc.getMap('backlinksVersion');
        const now = Date.now();
        for (const id of recipientPageIds) {
          bv.set(id, now);
        }
      });
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to update backlinksVersion for user ${recipientId}: ${error}`);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to update backlinks metadata');
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
  let targetPageIds: string[] = [];
  let pageMeta: PageMeta | undefined;

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
    const metaResult = await client.query<PageMeta>(
      'select title, icon, parent_id, position from pages where id = $1',
      [documentName],
    );
    pageMeta = metaResult.rows[0];

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

  // Notify only currently connected meta rooms. Offline users rebuild their
  // metadata from PostgreSQL when they reconnect, so opening rooms for them
  // here would add save latency without preserving useful state.
  const activeDocuments = getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) return;

  const affectedIds = [...new Set([documentName, ...targetPageIds])];
  const recipients = await getPageMetaRecipients(
    pool,
    affectedIds,
    Array.from(activeDocuments.keys()),
  );
  const results = await Promise.allSettled([
    updatePageMeta(hocuspocus, pool, documentName, logger, pageMeta, recipients, activeDocuments),
    updateBacklinksVersion(hocuspocus, pool, affectedIds, logger, recipients, activeDocuments),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as unknown);
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish metadata for ${documentName}`);
  }
}

export async function publishPageRename(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  newTitle: string,
  logger: Logger,
): Promise<void> {
  const activeDoc = hocuspocus.documents.get(pageId) as Y.Doc | undefined;
  if (activeDoc) {
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  const results = await Promise.allSettled([
    updatePageMeta(hocuspocus, pool, pageId, logger),
    updateBacklinksVersion(hocuspocus, pool, [pageId], logger),
  ]);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    failures.push(result.reason);
    logger.error(`[listen] failed to publish rename metadata for page ${pageId}: ${result.reason}`);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish rename metadata for ${pageId}`);
  }

  logger.debug(`[listen] updated meta for renamed page ${pageId} -> ${newTitle}`);
}

export async function publishPageDeletion(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
): Promise<void> {
  const activeDoc = hocuspocus.documents.get(pageId) as Document | undefined;
  if (activeDoc) {
    for (const connection of activeDoc.getConnections()) {
      connection.sendStateless(
        JSON.stringify({
          type: 'entity_deleted',
          entityType: 'page',
          entityId: pageId,
        }),
      );
      connection.close({ code: 4402, reason: 'Page deleted' });
    }
  }

  const activeDocuments = getActiveMetaDocuments(hocuspocus);
  const recipientIds = await getDeletedPageMetaRecipientIds(
    pool,
    pageId,
    Array.from(activeDocuments.keys()),
  );
  const failures: unknown[] = [];

  for (const recipientId of recipientIds) {
    const metaDoc = activeDocuments.get(recipientId);
    if (!metaDoc) continue;
    try {
      metaDoc.transact(() => {
        metaDoc.getMap('pageIndex').delete(pageId);
        metaDoc.getMap('backlinksVersion').set(pageId, Date.now());
      });
    } catch (error) {
      failures.push(error);
      logger.error(
        `[listen] failed to remove page ${pageId} from meta for user ${recipientId}: ${error}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish deletion metadata for ${pageId}`);
  }
  logger.debug(`[listen] removed deleted page ${pageId} from active meta rooms`);
}

export async function publishFolderDeletion(
  hocuspocus: Hocuspocus,
  pool: Pool,
  folderId: string,
  logger: Logger,
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `SELECT p.id
     FROM pages p
     JOIN folders deleted_root ON deleted_root.id = $1
     WHERE p.parent_id IN (
       SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1
     )
       AND p.is_deleted = true
       AND p.deleted_at = deleted_root.deleted_at`,
    [folderId],
  );

  const pageIds = result.rows.map((row) => row.id);
  const failures: unknown[] = [];
  const batchSize = 25;
  for (let offset = 0; offset < pageIds.length; offset += batchSize) {
    const batch = pageIds.slice(offset, offset + batchSize);
    const results = await Promise.allSettled(
      batch.map((pageId) => publishPageDeletion(hocuspocus, pool, pageId, logger)),
    );
    for (const [index, publishResult] of results.entries()) {
      if (publishResult.status === 'fulfilled') continue;
      const pageId = batch[index];
      failures.push(publishResult.reason);
      logger.error(
        `[listen] failed to publish folder deletion for page ${pageId ?? 'unknown'}: ${publishResult.reason}`,
      );
    }
  }

  try {
    const activeDocuments = getActiveMetaDocuments(hocuspocus);
    const recipientIds = await getDeletedFolderMetaRecipientIds(
      pool,
      folderId,
      Array.from(activeDocuments.keys()),
    );
    const message = JSON.stringify({
      type: 'entity_deleted',
      entityType: 'folder',
      entityId: folderId,
    });
    for (const recipientId of recipientIds) {
      const metaDoc = activeDocuments.get(recipientId);
      if (!metaDoc) continue;
      for (const connection of metaDoc.getConnections()) {
        connection.sendStateless(message);
      }
    }
  } catch (error) {
    failures.push(error);
    logger.error(`[listen] failed to publish folder metadata deletion for ${folderId}: ${error}`);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish all deletion events for ${folderId}`);
  }
  logger.debug(
    `[listen] published folder deletion and ${pageIds.length} page deletion(s) for ${folderId}`,
  );
}

export interface CollabServerConfig {
  port: number;
  pool: Pool;
  logger: Logger;
  debounceMs?: number;
  maxDebounceMs?: number;
  databaseUrl?: string;
  permissionRevalidationMs?: number;
}

export function createCollabServer(config: CollabServerConfig) {
  const {
    port,
    pool,
    logger,
    debounceMs = 500,
    maxDebounceMs = 3000,
    permissionRevalidationMs = 5000,
  } = config;
  type PersistContext = {
    user?: { id: string; isAnonymous?: boolean };
    permission?: string;
  };
  const pendingWriters = new Map<string, Map<string, PersistContext>>();
  const blockedDocuments = new Set<string>();

  async function assertPageAccess(
    documentName: string,
    userId: string,
  ): Promise<{ permission: 'view' | 'edit' | 'admin' }> {
    const ownerResult = await pool.query(
      'SELECT 1 FROM pages WHERE id = $1 AND is_deleted = false LIMIT 1',
      [documentName],
    );
    if (ownerResult.rowCount === 0) {
      logger.debug(`[auth] page=${documentName} not found`);
      throw new CollabAccessError();
    }
    const shareResult = await pool.query(
      'SELECT permission, full_access FROM get_effective_page_permission($1, $2)',
      [documentName, userId],
    );

    if (shareResult.rows.length === 0) {
      logger.debug(`[auth] user=${userId} denied access to page=${documentName} (no share)`);
      throw new CollabAccessError();
    }

    const rawPermission = shareResult.rows[0].permission;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(
        `[auth] user=${userId} denied access to page=${documentName} (invalid permission)`,
      );
      throw new CollabAccessError();
    }
    return { permission: rawPermission };
  }

  async function assertMetaRoomAccess(userId: string, roomUserId: string): Promise<void> {
    if (userId !== roomUserId) {
      logger.debug(`[auth] user=${userId} denied access to meta room for user=${roomUserId}`);
      throw new CollabAccessError();
    }
  }

  async function assertAnonymousPageAccess(
    documentName: string,
  ): Promise<{ permission: 'view' | 'edit' | 'admin' }> {
    const shareResult = await pool.query(
      `WITH page_parent AS (
         SELECT parent_id, is_public
         FROM pages
         WHERE id = $1 AND is_deleted = false
       )
       SELECT permission FROM (
         SELECT s.permission, 1 AS src
         FROM shares s
         WHERE s.entity_type = 'page' AND s.entity_id = $1 AND s.token IS NOT NULL
           AND (s.expires_at IS NULL OR s.expires_at > now())
           AND EXISTS (SELECT 1 FROM page_parent WHERE is_public = true)
         UNION ALL
         SELECT s.permission, 2 AS src
         FROM shares s
         JOIN folders f ON f.id = s.entity_id AND f.is_public = true AND f.is_deleted = false
          WHERE s.entity_type = 'folder' AND s.token IS NOT NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            AND s.entity_id IN (
              SELECT ancestor_id FROM folder_closure fc
              JOIN page_parent pp ON fc.descendant_id = pp.parent_id
            )
            AND NOT is_page_folder_inheritance_blocked(s.entity_id, $1)
        ) perms
       ORDER BY CASE permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
                src ASC
       LIMIT 1`,
      [documentName],
    );
    const rawPermission = shareResult.rows[0]?.permission;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(`[auth] anonymous denied: page ${documentName} has no valid link share`);
      throw new CollabAccessError();
    }
    return { permission: rawPermission };
  }

  function updateRevalidatedConnections(
    documentName: string,
    user: { id: string; isAnonymous?: boolean },
    permission: 'view' | 'edit' | 'admin' | null,
  ): void {
    const activeDoc = server.hocuspocus.documents.get(documentName) as Document | undefined;
    if (!activeDoc) return;

    for (const connection of activeDoc.getConnections()) {
      const connectionContext = connection.context as
        | { user?: { id: string; isAnonymous?: boolean }; permission?: unknown }
        | undefined;
      if (
        connectionContext?.user?.id !== user.id ||
        connectionContext.user.isAnonymous !== user.isAnonymous
      ) {
        continue;
      }
      if (!permission) {
        connection.sendStateless(
          JSON.stringify({ type: 'share_event', action: 'revoke' } satisfies StatelessShareMessage),
        );
        connection.close({ code: 4401, reason: 'Access revoked' });
        continue;
      }

      const readOnly = permission === 'view';
      if (connection.readOnly === readOnly && connectionContext.permission === permission) continue;
      connection.readOnly = readOnly;
      (connection.context as Record<string, unknown>).permission = permission;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'update',
          permission,
        } satisfies StatelessShareMessage),
      );
    }
  }

  async function canPersistDocument(
    documentName: string,
    context: { user?: { id: string; isAnonymous?: boolean }; permission?: string } | undefined,
  ): Promise<boolean> {
    if (!context?.user) return false;

    try {
      const access = context.user.isAnonymous
        ? await assertAnonymousPageAccess(documentName)
        : await assertPageAccess(documentName, context.user.id);
      context.permission = access.permission;
      updateRevalidatedConnections(documentName, context.user, access.permission);
      if (access.permission === 'view') {
        logger.warn(
          `[persist] permission dropped to view for user=${context.user.id} on page=${documentName}, skipping persist`,
        );
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof CollabAccessError) {
        updateRevalidatedConnections(documentName, context.user, null);
        logger.warn(
          `[persist] access revoked for user=${context.user.id} on page=${documentName}, skipping persist`,
        );
        return false;
      }
      logger.error(
        `[persist] failed to verify access for user=${context.user.id} on page=${documentName}: ${error}`,
      );
      throw error;
    }
  }

  async function canPersistPendingDocument(
    documentName: string,
    fallbackContext: PersistContext | undefined,
  ): Promise<boolean> {
    if (blockedDocuments.has(documentName)) return false;
    const writers = Array.from(pendingWriters.get(documentName)?.values() ?? []);
    if (writers.length === 0 && fallbackContext) writers.push(fallbackContext);

    for (const writer of writers) {
      if (await canPersistDocument(documentName, writer)) continue;

      // The in-memory Y.Doc may already contain this writer's rejected update.
      // Disconnect the affected room so Hocuspocus unloads it and reloads the
      // last persisted state rather than saving a mixed-author update later.
      blockedDocuments.add(documentName);
      const activeDocument = server.hocuspocus.documents.get(documentName) as Document | undefined;
      for (const connection of activeDocument?.getConnections() ?? []) {
        // Only the rejected writer receives a revoke/update event from the
        // targeted revalidation above. Other collaborators need a clean room
        // reload, not a false access-revocation notification.
        connection.close({ code: 4500, reason: 'Document reload required' });
      }
      pendingWriters.delete(documentName);
      return false;
    }
    return true;
  }

  async function handleWorkspaceEvent(
    action: 'member_added' | 'member_removed' | 'role_changed',
    ownerId: string,
    memberId: string,
    message?: string,
  ): Promise<void> {
    await handleWorkspaceEvent_(
      server,
      { type: 'workspace_event', action, ownerId, memberId, ...(message ? { message } : {}) },
      pool,
      logger,
    );
  }

  async function handleInviteReceived(payload: {
    entityType: string;
    entityId: string;
    entityTitle: string;
    sharedByName: string;
    targetUserId: string;
    message?: string;
  }): Promise<void> {
    if (!server.hocuspocus?.documents) {
      logger.debug('[invite] no active documents, skipping');
      return;
    }

    let affectedCount = 0;
    for (const [_pageId, doc] of server.hocuspocus.documents) {
      const activeDoc = doc as Document | undefined;
      if (!activeDoc) continue;

      const connections = activeDoc.getConnections();
      for (const connection of connections) {
        const ctx = connection.context as
          | { user?: { id: string; isAnonymous?: boolean } }
          | undefined;
        if (!ctx?.user || ctx.user.id !== payload.targetUserId) continue;

        connection.sendStateless(
          JSON.stringify({
            type: 'invite_received',
            entityType: payload.entityType,
            entityId: payload.entityId,
            entityTitle: payload.entityTitle,
            sharedByName: payload.sharedByName,
            ...(payload.message !== undefined && { message: payload.message }),
          }),
        );
        affectedCount++;
      }
    }

    logger.info(
      `[invite] sent invite_received to ${affectedCount} connection(s) for user=${payload.targetUserId}`,
    );
  }

  const server = new Server({
    port,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: async ({ token, requestHeaders, documentName, connectionConfig }) => {
      if (documentName && blockedDocuments.has(documentName)) {
        throw new CollabAccessError();
      }
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
      blockedDocuments.delete(documentName);
      pendingWriters.delete(documentName);
      if (isMetaRoom(documentName)) {
        const userId = documentName.slice(META_ROOM_PREFIX.length);
        logger.debug(`[meta] loading page meta for user: ${userId}`);

        const result = await pool.query(
          `select p.id, p.title, p.icon, p.parent_id, p.position
           from pages p
           where p.is_deleted = false
             and (
               p.id in (select page_id from get_accessible_page_ids($1))
               or exists (
                 select 1
                 from page_access_events pae
                 join lateral get_effective_page_permission(p.id, $1) access on true
                 where pae.page_id = p.id and pae.user_id = $1 and access.permission is not null
               )
               or exists (
                 select 1
                 from folder_access_events fae
                 join folder_closure fc
                   on fc.ancestor_id = fae.folder_id and fc.descendant_id = p.parent_id
                 join lateral get_effective_page_permission(p.id, $1) access on true
                 where fae.user_id = $1 and access.permission is not null
               )
             )
           order by p.position::numeric asc`,
          [userId],
        );

        const pageIndex = document.getMap('pageIndex');
        pageIndex.clear();
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
    onChange: async ({ documentName, context }) => {
      if (isMetaRoom(documentName) || blockedDocuments.has(documentName)) return;
      const writer = context as PersistContext | undefined;
      if (!writer?.user) return;
      const writerKey = `${writer.user.isAnonymous === true ? 'anonymous' : 'user'}:${writer.user.id}`;
      const writers = pendingWriters.get(documentName) ?? new Map<string, PersistContext>();
      writers.set(writerKey, writer);
      pendingWriters.set(documentName, writers);
    },
    onStoreDocument: async (data) => {
      const documentName = data.documentName;

      if (blockedDocuments.has(documentName)) return;
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

      if (!(await canPersistPendingDocument(documentName, context))) return;

      const state = Y.encodeStateAsUpdate(data.document);
      if (!state || state.length === 0) {
        logger.debug(`[persist] skipping empty state: ${documentName}`);
        return;
      }

      logger.info(`[persist] saving: "${documentName}", size: ${state.length} bytes`);
      try {
        await persistDocument(pool, server.hocuspocus, documentName, state, data.document, logger);
        pendingWriters.delete(documentName);
        logger.debug(`[persist] saved: ${documentName}`);
      } catch (err) {
        logger.error(`[persist] failed to save "${documentName}": ${err}`);
        throw err;
      }
    },
    afterUnloadDocument: async ({ documentName }) => {
      blockedDocuments.delete(documentName);
      pendingWriters.delete(documentName);
    },
    onDisconnect: async ({ documentName, instance, context }) => {
      if (isMetaRoom(documentName) || blockedDocuments.has(documentName)) return;

      const doc = instance.documents.get(documentName) as Y.Doc | undefined;
      if (!doc) return;

      try {
        const persistContext = context as
          | { user?: { id: string; isAnonymous?: boolean }; permission?: string }
          | undefined;
        if (!(await canPersistPendingDocument(documentName, persistContext))) return;

        const state = Y.encodeStateAsUpdate(doc);
        if (!state || state.length === 0) return;

        logger.info(`[disconnect] force saving: ${documentName}, ${state.length} bytes`);
        await persistDocument(pool, server.hocuspocus, documentName, state, doc, logger);
        pendingWriters.delete(documentName);
        logger.debug(`[disconnect] force saved: ${documentName}`);
      } catch (err) {
        logger.error(`[disconnect] force save failed for "${documentName}": ${err}`);
      }
    },
    extensions: [],
  });

  const shareEventQueue = createCoalescingTaskQueue<ShareEventPayload>({
    maxPending: SHARE_EVENT_QUEUE_LIMIT,
    getKey: (payload) =>
      `${payload.entityType}:${payload.entityId}:${payload.targetUserId ?? 'anonymous'}`,
    handle: (payload) => handleShareEvent(server, payload, pool, logger),
    handleOverflow: async () => {
      logger.warn(
        `[listen] share event backlog exceeded ${SHARE_EVENT_QUEUE_LIMIT}; revalidating all active connections`,
      );
      await revalidateActivePageConnections(server, pool, logger);
    },
    onError: (error) => logger.error(`[listen] handleShareEvent failed: ${error}`),
  });

  let permissionRevalidationRunning = false;
  const permissionRevalidationTimer =
    permissionRevalidationMs > 0
      ? setInterval(() => {
          if (permissionRevalidationRunning) return;
          permissionRevalidationRunning = true;
          void revalidateActivePageConnections(server, pool, logger)
            .catch((error) => logger.error(`[expiry] active access revalidation failed: ${error}`))
            .finally(() => {
              permissionRevalidationRunning = false;
            });
        }, permissionRevalidationMs)
      : null;
  permissionRevalidationTimer?.unref();

  const destroyBeforePermissionTimer = server.destroy.bind(server);
  Object.defineProperty(server, 'destroy', {
    value() {
      if (permissionRevalidationTimer) clearInterval(permissionRevalidationTimer);
      shareEventQueue.stop();
      return destroyBeforePermissionTimer();
    },
    writable: true,
    configurable: true,
  });

  const listenUrl = config.databaseUrl;
  if (listenUrl) {
    let listenClient: Client | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let stopped = false;
    const MAX_RECONNECT_DELAY = 30000;

    async function handlePageRenamed(pageId: string): Promise<void> {
      const result = await pool.query<{ title: string }>(
        'select title from pages where id = $1 and is_deleted = false',
        [pageId],
      );
      const title = result.rows[0]?.title;
      if (title === undefined) {
        logger.debug(`[listen] renamed page ${pageId} is no longer active, skipping`);
        return;
      }
      await publishPageRename(server.hocuspocus, pool, pageId, title, logger);
    }

    async function handlePageDeleted(pageId: string): Promise<void> {
      await publishPageDeletion(server.hocuspocus, pool, pageId, logger);
    }

    async function handleFolderDeleted(folderId: string): Promise<void> {
      await publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
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
        await client.query('LISTEN folder_deleted');
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
            } else if (msg.channel === 'folder_deleted') {
              const payload = JSON.parse(msg.payload ?? '{}') as { folderId?: string };
              if (!payload.folderId) return;
              void handleFolderDeleted(payload.folderId).catch((err) =>
                logger.error(`[listen] handleFolderDeleted failed: ${err}`),
              );
            } else if (msg.channel === 'page_renamed') {
              const payload = JSON.parse(msg.payload ?? '{}') as { pageId?: string };
              if (!payload.pageId) return;
              void handlePageRenamed(payload.pageId).catch((err) =>
                logger.error(`[listen] handlePageRenamed failed: ${err}`),
              );
            } else if (msg.channel === 'share_event') {
              logger.debug(`[listen] received share_event: ${msg.payload}`);
              const payload: ShareEventPayload | InviteReceivedPayload = JSON.parse(
                msg.payload ?? '{}',
              );
              if (!payload.entityId) {
                logger.debug('[listen] share_event missing entityId, skipping');
                return;
              }
              if (payload.type === 'invite_received') {
                void handleInviteReceived(payload).catch((err) =>
                  logger.error(`[listen] handleInviteReceived failed: ${err}`),
                );
              } else {
                shareEventQueue.enqueue(payload);
              }
            } else if (msg.channel === 'workspace_event') {
              logger.debug(`[listen] received workspace_event: ${msg.payload}`);
              const payload = JSON.parse(msg.payload ?? '{}') as {
                type: string;
                action: string;
                ownerId: string;
                memberId: string;
                message?: string;
              };
              if (!payload.ownerId || !payload.memberId) {
                logger.debug('[listen] workspace_event missing ownerId or memberId, skipping');
                return;
              }
              void handleWorkspaceEvent(
                payload.action as 'member_added' | 'member_removed' | 'role_changed',
                payload.ownerId,
                payload.memberId,
                payload.message,
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
