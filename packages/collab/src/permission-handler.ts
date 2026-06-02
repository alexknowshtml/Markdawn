import type { Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { ShareEventPayload, SharePermission, StatelessShareMessage } from '@markdawn/shared';
import type { Pool } from 'pg';

/**
 * Map a permission string to a recognised client-facing value.
 * Returns `undefined` for unknown values so the caller can skip gracefully.
 */
function clientPermission(permission: string | undefined): SharePermission | undefined {
  if (permission === 'admin' || permission === 'edit' || permission === 'view') return permission;
  return undefined;
}

/**
 * Handle a share event from pg_notify. Finds all active WebSocket connections
 * to the affected document and applies the permission change in realtime:
 *
 * - `revoke`: sends a stateless message and closes the connection (code 4401)
 * - `grant`/`update`: sets `readOnly` and sends a stateless message
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
  const { entityId: pageId, action, permission: rawPermission, targetUserId } = payload;

  logger.debug(
    `[share] received event: action=${action} page=${pageId} permission=${rawPermission ?? 'none'} targetUserId=${targetUserId ?? 'all'}`,
  );

  const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
  if (!activeDoc) {
    logger.debug(`[share] no active document for page ${pageId}, skipping`);
    return;
  }

  const connections = activeDoc.getConnections();
  const permission = clientPermission(rawPermission);
  let affectedCount = 0;

  // For link share events (no targetUserId), pre-fetch the base permissions
  // for the page owner and all directly invited users. This lets us compute
  // each connection's effective permission after the link change.
  const isLinkShareEvent = targetUserId === undefined;
  let basePermissions: Map<string, SharePermission | 'edit'> | undefined;
  if (isLinkShareEvent && pool) {
    try {
      const result = await pool.query(
        `SELECT p.created_by AS user_id, 'edit'::varchar AS permission FROM pages p WHERE p.id = $1
         UNION
         SELECT recipient_user_id, permission FROM shares WHERE entity_type = 'page' AND entity_id = $1 AND token IS NULL AND recipient_user_id IS NOT NULL`,
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
    }
  }

  const rank = (p: string) => (p === 'admin' ? 3 : p === 'edit' ? 2 : 1);

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
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action,
          permission: effectivePermission,
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
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'revoke',
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
      const wasReadOnly = connection.readOnly === true;
      if (wasReadOnly === isReadOnly) {
        // Permission unchanged for this user, skip notification
        logger.debug(
          `[share] skipping ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId} (permission unchanged: ${permission})`,
        );
        continue;
      }
      connection.readOnly = isReadOnly;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action,
          permission,
        } satisfies StatelessShareMessage),
      );
      logger.info(
        `[share] set ${isReadOnly ? 'read-only' : 'editable'} for ${ctx.user.isAnonymous ? 'anonymous' : 'user'}=${ctx.user.id} on page ${pageId}`,
      );
    }
  }

  logger.info(
    `[share] processed ${action} for page ${pageId}: ${affectedCount} connection(s) affected`,
  );
}
