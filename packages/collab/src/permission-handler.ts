import type { Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type {
  ShareEventPayload,
  SharePermission,
  StatelessShareEventAction,
  StatelessShareMessage,
} from '@markdawn/shared';
import type { Pool } from 'pg';

/**
 * Map a permission string to a recognised client-facing value.
 * Returns `undefined` for unknown values so the caller can skip gracefully.
 */
function clientPermission(permission: string | undefined): SharePermission | undefined {
  if (permission === 'admin' || permission === 'edit' || permission === 'view') return permission;
  return undefined;
}

const rank = (p: string) => (p === 'admin' ? 3 : p === 'edit' ? 2 : 1);

type ConnectionContext = {
  user?: { id: string; isAnonymous?: boolean };
  permission?: unknown;
};

async function getAnonymousPagePermission(
  pool: Pool,
  pageId: string,
): Promise<SharePermission | null> {
  const result = await pool.query(
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
    [pageId],
  );
  return clientPermission(result.rows[0]?.permission as string | undefined) ?? null;
}

async function getAuthenticatedPagePermissions(
  pool: Pool,
  pageId: string,
  userIds: string[],
): Promise<Map<string, SharePermission | null>> {
  if (userIds.length === 0) return new Map();

  const result = await pool.query<{ user_id: string; permission: string | null }>(
    `WITH requested_users AS (
       SELECT DISTINCT unnest($2::uuid[]) AS user_id
     )
     SELECT requested_users.user_id, access.permission
     FROM requested_users
     LEFT JOIN LATERAL get_effective_page_permission($1, requested_users.user_id) access ON true`,
    [pageId, userIds],
  );
  return new Map(
    result.rows.map((row) => [row.user_id, clientPermission(row.permission ?? undefined) ?? null]),
  );
}

/**
 * Recompute every active connection's effective permission from the database.
 * Used for inheritance-policy changes where affected users are not known ahead
 * of time and permissions may be revoked, downgraded, or upgraded indirectly.
 */
async function recomputePageConnections(
  server: Server,
  pageId: string,
  pool: Pool | undefined,
  logger: Logger,
  message?: string,
  targetUserId?: string,
): Promise<number> {
  const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
  if (!activeDoc) {
    logger.debug(`[share] no active document for page ${pageId}, skipping`);
    return 0;
  }

  if (!pool) {
    logger.warn(`[share] cannot recompute permissions for page ${pageId}: no database pool`);
    return 0;
  }

  const connections = activeDoc.getConnections();
  let affectedCount = 0;
  const candidates = connections.flatMap((connection) => {
    const ctx = connection.context as ConnectionContext | undefined;
    if (!ctx?.user) {
      logger.debug('[share] connection has no user context, skipping');
      return [];
    }
    if (targetUserId !== undefined && ctx.user.id !== targetUserId) return [];
    return [{ connection, ctx }];
  });
  const authenticatedUserIds = Array.from(
    new Set(
      candidates
        .filter(({ ctx }) => ctx.user?.isAnonymous !== true)
        .map(({ ctx }) => ctx.user?.id)
        .filter((userId): userId is string => userId !== undefined),
    ),
  );
  const hasAnonymousConnections = candidates.some(({ ctx }) => ctx.user?.isAnonymous === true);
  const [authenticatedResult, anonymousResult] = await Promise.allSettled([
    getAuthenticatedPagePermissions(pool, pageId, authenticatedUserIds),
    hasAnonymousConnections
      ? getAnonymousPagePermission(pool, pageId)
      : Promise.resolve<SharePermission | null>(null),
  ]);

  for (const { connection, ctx } of candidates) {
    const user = ctx.user;
    if (!user) continue;
    const permissionResult = user.isAnonymous ? anonymousResult : authenticatedResult;
    if (permissionResult.status === 'rejected') {
      logger.error(
        `[share] failed to recompute permission for user=${user.id} on page=${pageId}: ${permissionResult.reason}`,
      );
      // Fail closed without claiming access was revoked. The client can
      // reconnect and distinguish a verification outage from a real revoke by
      // the close code.
      connection.close({ code: 4500, reason: 'Permission verification failed' });
      affectedCount++;
      continue;
    }

    const permission = user.isAnonymous
      ? (permissionResult.value as SharePermission | null)
      : ((permissionResult.value as Map<string, SharePermission | null>).get(user.id) ?? null);
    if (!permission) {
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'revoke',
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: 'Access revoked' });
      logger.info(
        `[share] revoked ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page ${pageId} after permission recompute`,
      );
      affectedCount++;
      continue;
    }

    const isReadOnly = permission === 'view';
    const previousPermission = typeof ctx.permission === 'string' ? ctx.permission : undefined;
    if (connection.readOnly === isReadOnly && previousPermission === permission) {
      logger.debug(
        `[share] skipping user=${user.id} on page ${pageId} (recomputed permission unchanged: ${permission})`,
      );
      continue;
    }

    connection.readOnly = isReadOnly;
    (connection.context as Record<string, unknown>).permission = permission;
    connection.sendStateless(
      JSON.stringify({
        type: 'share_event',
        action: 'update',
        permission,
        ...(message !== undefined && { message }),
      } satisfies StatelessShareMessage),
    );
    logger.info(
      `[share] recomputed ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page ${pageId} to ${permission}`,
    );
    affectedCount++;
  }

  return affectedCount;
}

const PAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Periodically revalidate active page rooms so time-based share expiry takes
 * effect even when a connection is only receiving updates.
 * Authenticated page/user pairs and anonymous pages are queried in two
 * batches, independent of the number of open sockets.
 */
export async function revalidateActivePageConnections(
  server: Server,
  pool: Pool,
  logger: Logger,
): Promise<number> {
  const candidates: Array<{
    pageId: string;
    connection: ReturnType<Document['getConnections']>[number];
    ctx: ConnectionContext;
  }> = [];

  for (const [pageId, document] of server.hocuspocus?.documents ?? []) {
    if (!PAGE_ID_PATTERN.test(pageId)) continue;
    for (const connection of (document as Document).getConnections()) {
      const ctx = connection.context as ConnectionContext | undefined;
      if (!ctx?.user) continue;
      candidates.push({ pageId, connection, ctx });
    }
  }
  if (candidates.length === 0) return 0;

  const authenticatedPairs = new Map<string, { pageId: string; userId: string }>();
  const anonymousPageIds = new Set<string>();
  for (const { pageId, ctx } of candidates) {
    const user = ctx.user;
    if (!user) continue;
    if (user.isAnonymous === true) {
      anonymousPageIds.add(pageId);
    } else {
      authenticatedPairs.set(`${pageId}:${user.id}`, { pageId, userId: user.id });
    }
  }

  const pairs = Array.from(authenticatedPairs.values());
  const anonymousIds = Array.from(anonymousPageIds);
  const authenticatedPromise =
    pairs.length === 0
      ? Promise.resolve(new Map<string, SharePermission | null>())
      : pool
          .query<{ page_id: string; user_id: string; permission: string | null }>(
            `with requested as (
               select *
               from unnest($1::uuid[], $2::uuid[]) as pair(page_id, user_id)
             )
             select requested.page_id, requested.user_id, access.permission
             from requested
             left join lateral get_effective_page_permission(
               requested.page_id,
               requested.user_id
             ) access on true`,
            [pairs.map((pair) => pair.pageId), pairs.map((pair) => pair.userId)],
          )
          .then(
            (result) =>
              new Map(
                result.rows.map((row) => [
                  `${row.page_id}:${row.user_id}`,
                  clientPermission(row.permission ?? undefined) ?? null,
                ]),
              ),
          );
  const anonymousPromise =
    anonymousIds.length === 0
      ? Promise.resolve(new Map<string, SharePermission | null>())
      : pool
          .query<{ page_id: string; permission: string | null }>(
            `with requested as (
               select distinct unnest($1::uuid[]) as page_id
             )
             select requested.page_id, access.permission
             from requested
             left join lateral (
               with page_parent as (
                 select parent_id, is_public
                 from pages
                 where id = requested.page_id and is_deleted = false
               )
               select permission
               from (
                 select s.permission, 1 as src
                 from shares s
                 where s.entity_type = 'page'
                   and s.entity_id = requested.page_id
                   and s.token is not null
                   and (s.expires_at is null or s.expires_at > now())
                   and exists (select 1 from page_parent where is_public = true)
                 union all
                 select s.permission, 2 as src
                 from shares s
                 join folders f
                   on f.id = s.entity_id and f.is_public = true and f.is_deleted = false
                 where s.entity_type = 'folder'
                   and s.token is not null
                   and (s.expires_at is null or s.expires_at > now())
                   and s.entity_id in (
                     select ancestor_id
                     from folder_closure fc
                     join page_parent pp on fc.descendant_id = pp.parent_id
                   )
                   and not is_page_folder_inheritance_blocked(
                     s.entity_id,
                     requested.page_id
                   )
               ) permissions
               order by case permission when 'admin' then 3 when 'edit' then 2 else 1 end desc,
                        src asc
               limit 1
             ) access on true`,
            [anonymousIds],
          )
          .then(
            (result) =>
              new Map(
                result.rows.map((row) => [
                  row.page_id,
                  clientPermission(row.permission ?? undefined) ?? null,
                ]),
              ),
          );

  const [authenticatedResult, anonymousResult] = await Promise.allSettled([
    authenticatedPromise,
    anonymousPromise,
  ]);
  let affectedCount = 0;
  for (const { pageId, connection, ctx } of candidates) {
    const user = ctx.user;
    if (!user) continue;
    const result = user.isAnonymous ? anonymousResult : authenticatedResult;
    if (result.status === 'rejected') {
      logger.error(
        `[expiry] failed to revalidate ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page=${pageId}: ${result.reason}`,
      );
      connection.close({ code: 4500, reason: 'Permission verification failed' });
      affectedCount++;
      continue;
    }

    const permission = user.isAnonymous
      ? (result.value as Map<string, SharePermission | null>).get(pageId)
      : (result.value as Map<string, SharePermission | null>).get(`${pageId}:${user.id}`);
    if (!permission) {
      connection.sendStateless(
        JSON.stringify({ type: 'share_event', action: 'revoke' } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: 'Access revoked' });
      logger.info(
        `[expiry] revoked ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page=${pageId}`,
      );
      affectedCount++;
      continue;
    }

    const readOnly = permission === 'view';
    if (connection.readOnly === readOnly && ctx.permission === permission) continue;
    connection.readOnly = readOnly;
    (connection.context as Record<string, unknown>).permission = permission;
    connection.sendStateless(
      JSON.stringify({
        type: 'share_event',
        action: 'update',
        permission,
      } satisfies StatelessShareMessage),
    );
    affectedCount++;
  }

  return affectedCount;
}

/**
 * Apply a share event to all active connections on a single page document.
 * Returns the number of connections affected.
 */
async function applyShareEventToPage(
  server: Server,
  pageId: string,
  action: StatelessShareEventAction,
  rawPermission: string | undefined,
  targetUserId: string | undefined,
  pool: Pool | undefined,
  logger: Logger,
  message?: string,
): Promise<number> {
  const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
  if (!activeDoc) {
    logger.debug(`[share] no active document for page ${pageId}, skipping`);
    return 0;
  }

  const connections = activeDoc.getConnections();
  const permission = clientPermission(rawPermission);
  let affectedCount = 0;

  // For link share events (no targetUserId), pre-fetch the base permissions
  // for the page owner and all directly invited users. This lets us compute
  // each connection's effective permission after the link change.
  const isLinkShareEvent = targetUserId === undefined;
  let basePermissions: Map<string, SharePermission | 'edit'> | undefined;
  let basePermissionsFailed = false;
  if (isLinkShareEvent && pool) {
    try {
      const result = await pool.query(
        'SELECT user_id, permission FROM get_page_base_permissions($1)',
        [pageId],
      );
      basePermissions = new Map(
        result.rows.map((r: { user_id: string; permission: string }) => [
          r.user_id,
          r.permission as SharePermission | 'edit',
        ]),
      );
    } catch (err) {
      logger.error(`[share] failed to query base permissions for page ${pageId}: ${err}`);
      basePermissionsFailed = true;
    }
  }

  // If permissions cannot be verified after a link change, disconnect every
  // affected session. Reconnection will run the normal authentication path.
  if (basePermissionsFailed) {
    logger.warn(
      `[share] base permissions unavailable for page ${pageId}, closing active connections`,
    );
    for (const connection of connections) {
      connection.close({ code: 4500, reason: 'Permission verification failed' });
    }
    return connections.length;
  }

  logger.debug(`[share] found document for page ${pageId}, ${connections.length} connection(s)`);

  for (const connection of connections) {
    const ctx = connection.context as { user?: { id: string; isAnonymous?: boolean } } | undefined;
    if (!ctx?.user) {
      logger.debug(`[share] connection has no user context, skipping`);
      continue;
    }

    const isTargeted = targetUserId !== undefined;
    const isAffectedAnonymous = !isTargeted && ctx.user.isAnonymous === true;
    const isAffectedUser = isTargeted && ctx.user.id === targetUserId;

    // --- Link share events: handle authenticated users ---
    if (isLinkShareEvent && !ctx.user.isAnonymous) {
      const basePerm = basePermissions?.get(ctx.user.id);

      if (action === 'revoke') {
        // Revoke: only disconnect users with no independent access.
        // Users with a base permission (owner or invite) keep their access.
        if (basePerm !== undefined) {
          logger.debug(
            `[share] skipping revoke for privileged user=${ctx.user.id} (base=${basePerm})`,
          );
          continue;
        }
        connection.sendStateless(
          JSON.stringify({
            type: 'share_event',
            action: 'revoke',
            ...(message !== undefined && { message }),
          } satisfies StatelessShareMessage),
        );
        connection.close({ code: 4401, reason: 'Access revoked' });
        logger.info(`[share] revoked link-only user=${ctx.user.id} on page ${pageId}`);
        affectedCount++;
        continue;
      }

      // grant / update: compute effective permission for EVERY connection
      // (privileged and link-only alike) based on their base + the new link.
      if (!permission) {
        logger.debug(`[share] unknown permission "${rawPermission}" for page ${pageId}, skipping`);
        continue;
      }
      const effectivePermission =
        basePerm !== undefined && rank(basePerm) > rank(permission) ? basePerm : permission;
      const isReadOnly = effectivePermission === 'view';
      const wasReadOnly = connection.readOnly === true;
      if (wasReadOnly === isReadOnly) {
        // Effective permission unchanged for this user, skip notification
        logger.debug(
          `[share] skipping user=${ctx.user.id} on page ${pageId} (effective permission unchanged: ${effectivePermission})`,
        );
        continue;
      }
      connection.readOnly = isReadOnly;
      // Keep context.permission in sync so onStoreDocument reads the correct value.
      (connection.context as Record<string, unknown>).permission = effectivePermission;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action,
          permission: effectivePermission,
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      logger.info(
        `[share] set ${isReadOnly ? 'read-only' : 'editable'} for user=${ctx.user.id} on page ${pageId} (base=${basePerm ?? 'none'} link=${permission} effective=${effectivePermission})`,
      );
      affectedCount++;
      continue;
    }

    // --- Targeted (invite) events or anonymous link share events ---
    if (!isAffectedAnonymous && !isAffectedUser) continue;
    affectedCount++;

    if (action === 'revoke') {
      // For targeted revokes, ask the canonical permission function whether
      // another valid path remains. Null and query failures both fail closed.
      if (isTargeted && pool) {
        try {
          const permResult = await pool.query(
            'SELECT permission FROM get_effective_page_permission($1, $2)',
            [pageId, ctx.user.id],
          );
          const newPermission = clientPermission(
            permResult.rows[0]?.permission as string | undefined,
          );
          if (newPermission) {
            const isReadOnly = newPermission === 'view';
            connection.readOnly = isReadOnly;
            (connection.context as Record<string, unknown>).permission = newPermission;
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'update',
                permission: newPermission,
                ...(message !== undefined && { message }),
              } satisfies StatelessShareMessage),
            );
            logger.info(
              `[share] updated permission for user=${ctx.user.id} on page ${pageId} to ${newPermission} (remaining access after revoke)`,
            );
            affectedCount++;
            continue;
          }
        } catch (err) {
          logger.error(
            `[share] failed to compute remaining access for user=${ctx.user.id} on page=${pageId}: ${err}`,
          );
        }
      }
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'revoke',
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: 'Access revoked' });
      logger.info(
        `[share] revoked ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId}`,
      );
      continue;
    }

    if (!permission) {
      logger.debug(`[share] unknown permission "${rawPermission}" for page ${pageId}, skipping`);
      continue;
    }

    if (action === 'grant' || action === 'update') {
      const isReadOnly = permission === 'view';
      // For targeted events (invite changes), always send notification even if
      // readOnly didn't change — the permission level itself may have changed
      // (e.g., 'edit' → 'admin') and the user needs to see the toast.
      connection.readOnly = isReadOnly;
      (connection.context as Record<string, unknown>).permission = permission;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action,
          permission,
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      logger.info(
        `[share] set ${isReadOnly ? 'read-only' : 'editable'} for ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId} (permission=${permission})`,
      );
    }
  }

  return affectedCount;
}

/**
 * Handle a share event from pg_notify. Finds all active WebSocket connections
 * to the affected document(s) and applies the permission change in realtime:
 *
 * - `entityType = 'page'`: applies to the single page document
 * - `entityType = 'folder'`: applies to all pages in the folder and its descendants
 *
 * Connection matching:
 * - `targetUserId = undefined` → affects all anonymous connections (link share)
 * - `targetUserId = string`    → affects that specific user (email invite)
 */
export async function handleShareEvent(
  server: Server,
  payload: ShareEventPayload,
  pool: Pool | undefined,
  logger: Logger,
): Promise<void> {
  const {
    entityType,
    entityId,
    action,
    permission: rawPermission,
    targetUserId,
    message,
  } = payload;

  logger.debug(
    `[share] received event: action=${action} entityType=${entityType} entity=${entityId} permission=${rawPermission ?? 'none'} targetUserId=${targetUserId ?? 'all'}`,
  );

  // For folders, find all pages in the subtree and apply to each.
  if (entityType === 'folder') {
    let pageIds: string[] = [];
    if (pool) {
      try {
        const result = await pool.query(
          `SELECT p.id FROM pages p
          WHERE p.parent_id IN (
            SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1
          ) AND p.is_deleted = false`,
          [entityId],
        );
        pageIds = result.rows.map((r: { id: string }) => r.id);
      } catch (err) {
        logger.error(`[share] failed to query pages in folder ${entityId}: ${err}`);
        // The subtree lookup failed, so revalidate matching users on every
        // active page. Each per-page check still fails closed, while users
        // whose effective access can be verified remain connected.
        for (const activePageId of server.hocuspocus?.documents?.keys() ?? []) {
          if (activePageId.startsWith('page-meta:')) continue;
          await recomputePageConnections(server, activePageId, pool, logger, message, targetUserId);
        }
        return;
      }
    }

    if (pageIds.length === 0) {
      logger.debug(`[share] no active pages found in folder ${entityId}, skipping`);
      return;
    }

    logger.debug(`[share] folder ${entityId} has ${pageIds.length} page(s), propagating to each`);

    let totalAffected = 0;
    for (const pageId of pageIds) {
      totalAffected +=
        pool !== undefined
          ? await recomputePageConnections(server, pageId, pool, logger, message)
          : action === 'recompute'
            ? await recomputePageConnections(server, pageId, pool, logger, message)
            : await applyShareEventToPage(
                server,
                pageId,
                action,
                rawPermission,
                targetUserId,
                pool,
                logger,
                message,
              );
    }

    logger.info(
      `[share] processed ${action} for folder ${entityId}: ${pageIds.length} page(s), ${totalAffected} connection(s) affected`,
    );
    return;
  }

  if (pool !== undefined || action === 'recompute') {
    const affectedCount = await recomputePageConnections(server, entityId, pool, logger, message);
    logger.info(
      `[share] processed recompute for page ${entityId}: ${affectedCount} connection(s) affected`,
    );
    return;
  }

  // Fallback for tests/dev callers without a database pool.
  const affectedCount = await applyShareEventToPage(
    server,
    entityId,
    action,
    rawPermission,
    targetUserId,
    pool,
    logger,
    message,
  );

  logger.info(
    `[share] processed ${action} for page ${entityId}: ${affectedCount} connection(s) affected`,
  );
}

export interface WorkspaceEventPayload {
  type: 'workspace_event';
  action: 'member_added' | 'member_removed' | 'role_changed';
  ownerId: string;
  memberId: string;
  message?: string;
}

export async function handleWorkspaceEvent(
  server: Server,
  payload: WorkspaceEventPayload,
  pool: Pool | undefined,
  logger: Logger,
): Promise<void> {
  const { action, ownerId, memberId, message } = payload;

  logger.debug(`[workspace] received event: action=${action} owner=${ownerId} member=${memberId}`);

  const metaDocument = server.hocuspocus?.documents?.get(`page-meta:${memberId}`) as
    | Document
    | undefined;
  for (const connection of metaDocument?.getConnections() ?? []) {
    connection.sendStateless(
      JSON.stringify({
        type: 'workspace_membership_event',
        action,
        ownerId,
      }),
    );
  }

  if (!pool) {
    logger.warn('[workspace] no pool available, skipping');
    return;
  }

  const activePageIds = Array.from(server.hocuspocus?.documents?.keys() ?? []).filter(
    (documentName) => !documentName.startsWith('page-meta:'),
  );
  if (activePageIds.length === 0) {
    logger.debug(`[workspace] no active pages for workspace owner ${ownerId}, skipping`);
    return;
  }

  let pageIds: string[] = [];
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT p.id
       FROM pages p
       WHERE p.id = ANY($2::uuid[])
         AND p.is_deleted = false
         AND COALESCE(get_root_folder_owner(p.parent_id), p.created_by) = $1`,
      [ownerId, activePageIds],
    );
    pageIds = result.rows.map((row) => row.id);
  } catch (err) {
    logger.error(`[workspace] failed to query active pages for workspace owner ${ownerId}: ${err}`);
    // The workspace could not be identified, so revalidate only this member
    // on active pages. Each recomputation remains fail closed.
    for (const activePageId of activePageIds) {
      await recomputePageConnections(server, activePageId, pool, logger, message, memberId);
    }
    return;
  }

  if (pageIds.length === 0) {
    logger.debug(`[workspace] no matching active pages for workspace owner ${ownerId}, skipping`);
    return;
  }

  let permissions: Map<string, SharePermission | null>;
  let permissionQueryFailed = false;
  try {
    const permissionResult = await pool.query<{ page_id: string; permission: string | null }>(
      `WITH requested_pages AS (
         SELECT unnest($1::uuid[]) AS page_id
       )
       SELECT requested_pages.page_id, access.permission
       FROM requested_pages
       LEFT JOIN LATERAL get_effective_page_permission(requested_pages.page_id, $2) access ON true`,
      [pageIds, memberId],
    );
    permissions = new Map(
      permissionResult.rows.map((row) => [
        row.page_id,
        clientPermission(row.permission ?? undefined) ?? null,
      ]),
    );
  } catch (err) {
    permissionQueryFailed = true;
    logger.error(`[workspace] failed to batch permissions for user=${memberId}: ${err}`);
    permissions = new Map(pageIds.map((pageId) => [pageId, null]));
  }

  for (const pageId of pageIds) {
    const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
    if (!activeDoc) continue;
    const permission = permissions.get(pageId) ?? null;

    for (const connection of activeDoc.getConnections()) {
      const ctx = connection.context as ConnectionContext | undefined;
      if (ctx?.user?.id !== memberId) continue;

      if (!permission) {
        if (permissionQueryFailed) {
          connection.close({ code: 4500, reason: 'Permission verification failed' });
          logger.warn(
            `[workspace] could not verify user=${memberId} on page ${pageId} (${action})`,
          );
        } else {
          connection.sendStateless(
            JSON.stringify({
              type: 'share_event',
              action: 'revoke',
              ...(message !== undefined && { message }),
            } satisfies StatelessShareMessage),
          );
          connection.close({ code: 4401, reason: 'Access revoked' });
          logger.info(`[workspace] revoked user=${memberId} on page ${pageId} (${action})`);
        }
        continue;
      }

      connection.readOnly = permission === 'view';
      (connection.context as Record<string, unknown>).permission = permission;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'update',
          permission,
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      logger.info(
        `[workspace] updated user=${memberId} on page ${pageId} to ${permission} (${action})`,
      );
    }
  }
}
