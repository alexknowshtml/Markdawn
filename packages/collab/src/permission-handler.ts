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

async function getAuthenticatedPagePermission(
  pool: Pool,
  pageId: string,
  userId: string,
): Promise<SharePermission | null> {
  const result = await pool.query('SELECT permission FROM get_effective_page_permission($1, $2)', [
    pageId,
    userId,
  ]);
  return clientPermission(result.rows[0]?.permission as string | undefined) ?? null;
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

  for (const connection of connections) {
    const ctx = connection.context as ConnectionContext | undefined;
    if (!ctx?.user) {
      logger.debug('[share] connection has no user context, skipping');
      continue;
    }

    let permission: SharePermission | null;
    try {
      permission = ctx.user.isAnonymous
        ? await getAnonymousPagePermission(pool, pageId)
        : await getAuthenticatedPagePermission(pool, pageId, ctx.user.id);
    } catch (err) {
      logger.error(
        `[share] failed to recompute permission for user=${ctx.user.id} on page=${pageId}: ${err}`,
      );
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'revoke',
          ...(message !== undefined && { message }),
        } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: 'Access revoked' });
      affectedCount++;
      continue;
    }

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
        `[share] revoked ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId} after permission recompute`,
      );
      affectedCount++;
      continue;
    }

    const isReadOnly = permission === 'view';
    const previousPermission = typeof ctx.permission === 'string' ? ctx.permission : undefined;
    if (connection.readOnly === isReadOnly && previousPermission === permission) {
      logger.debug(
        `[share] skipping user=${ctx.user.id} on page ${pageId} (recomputed permission unchanged: ${permission})`,
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
      `[share] recomputed ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId} to ${permission}`,
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

  // If the base permissions query failed, we cannot safely determine who has
  // independent access — bail out rather than potentially disconnecting owners.
  if (basePermissionsFailed) {
    logger.warn(
      `[share] base permissions unavailable for page ${pageId}, skipping link share processing`,
    );
    return 0;
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
      // For targeted revokes, check if the user has remaining access paths
      // before disconnecting (e.g., access via parent folder or link share).
      if (isTargeted && pool) {
        try {
          const accessCheck = await pool.query(
            `WITH page_parent AS (SELECT parent_id FROM pages WHERE id = $1)
             SELECT 1 FROM (
               SELECT 1 FROM shares
               WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2
                 AND token IS NULL
               UNION ALL
               SELECT 1 FROM shares s
               JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
               JOIN page_parent pp ON fc.descendant_id = pp.parent_id
               WHERE s.entity_type = 'folder' AND s.recipient_user_id = $2 AND s.token IS NULL
               UNION ALL
               SELECT 1 FROM shares
               WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL
               UNION ALL
               SELECT 1 FROM shares s
               JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
               JOIN page_parent pp ON fc.descendant_id = pp.parent_id
               WHERE s.entity_type = 'folder' AND s.token IS NOT NULL
             ) remaining LIMIT 1`,
            [pageId, ctx.user.id],
          );
          const hasRemainingAccess = (accessCheck.rowCount ?? 0) > 0;
          if (hasRemainingAccess) {
            // User still has access via other paths — update their effective
            // permission downward (e.g. folder edit → direct page view).
            const permResult = await pool.query(
              'SELECT permission FROM get_effective_page_permission($1, $2)',
              [pageId, ctx.user.id],
            );
            const newPermission = (permResult.rows[0]?.permission as string | undefined) ?? 'view';
            const isReadOnly = newPermission !== 'edit' && newPermission !== 'admin';
            connection.readOnly = isReadOnly;
            (connection.context as Record<string, unknown>).permission = newPermission;
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'update',
                permission: newPermission as SharePermission,
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
        action === 'recompute'
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

  if (action === 'recompute') {
    const affectedCount = await recomputePageConnections(server, entityId, pool, logger, message);
    logger.info(
      `[share] processed recompute for page ${entityId}: ${affectedCount} connection(s) affected`,
    );
    return;
  }

  // For pages, apply directly
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

  if (!pool) {
    logger.warn('[workspace] no pool available, skipping');
    return;
  }

  // Find all active page documents owned by the workspace owner
  let pageIds: string[] = [];
  try {
    const result = await pool.query(
      `SELECT DISTINCT p.id FROM pages p
       WHERE p.is_deleted = false
         AND COALESCE(get_root_folder_owner(p.parent_id), p.created_by) = $1`,
      [ownerId],
    );
    pageIds = result.rows.map((r: { id: string }) => r.id);
  } catch (err) {
    logger.error(`[workspace] failed to query pages for workspace owner ${ownerId}: ${err}`);
    return;
  }

  if (pageIds.length === 0) {
    logger.debug(`[workspace] no active pages found for workspace owner ${ownerId}, skipping`);
    return;
  }

  // For member_removed, revoke access from all affected pages
  // For member_added/role_changed, update permissions on all affected pages
  for (const pageId of pageIds) {
    const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
    if (!activeDoc) continue;

    const connections = activeDoc.getConnections();
    for (const connection of connections) {
      const ctx = connection.context as { user?: { id: string } } | undefined;
      if (ctx?.user?.id !== memberId) continue;

      if (action === 'member_removed') {
        // Check if user has other access paths before disconnecting
        try {
          const accessCheck = await pool.query(
            'SELECT permission FROM get_effective_page_permission($1, $2)',
            [pageId, memberId],
          );
          const row = accessCheck.rows[0] as { permission: string | null } | undefined;
          if (!row || row.permission === null) {
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'revoke',
                ...(message !== undefined && { message }),
              }),
            );
            connection.close({ code: 4401, reason: 'Access revoked' });
            logger.info(
              `[workspace] revoked user=${memberId} on page ${pageId} (workspace member removed)`,
            );
          } else {
            // Still has access via other paths, update readOnly
            const isReadOnly = row.permission === 'view';
            connection.readOnly = isReadOnly;
            (connection.context as Record<string, unknown>).permission = row.permission;
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'update',
                permission: row.permission,
                ...(message !== undefined && { message }),
              }),
            );
            logger.info(
              `[workspace] updated user=${memberId} on page ${pageId} to ${row.permission} (member removed but remaining access)`,
            );
          }
        } catch (err) {
          logger.error(
            `[workspace] failed to check access for user=${memberId} on page=${pageId}: ${err}`,
          );
        }
      } else {
        // member_added or role_changed: recompute effective permission
        try {
          const permResult = await pool.query(
            'SELECT permission FROM get_effective_page_permission($1, $2)',
            [pageId, memberId],
          );
          const row = permResult.rows[0] as { permission: string | null } | undefined;
          const newPermission = (row?.permission as string | undefined) ?? 'view';
          const isReadOnly = newPermission === 'view';
          connection.readOnly = isReadOnly;
          (connection.context as Record<string, unknown>).permission = newPermission;
          connection.sendStateless(
            JSON.stringify({
              type: 'share_event',
              action: 'update',
              permission: newPermission as SharePermission,
              ...(message !== undefined && { message }),
            }),
          );
          logger.info(
            `[workspace] updated user=${memberId} on page ${pageId} to ${newPermission} (${action})`,
          );
        } catch (err) {
          logger.error(
            `[workspace] failed to update permission for user=${memberId} on page=${pageId}: ${err}`,
          );
        }
      }
    }
  }
}
