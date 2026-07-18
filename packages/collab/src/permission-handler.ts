import type { Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type {
  PermissionSnapshotMessage,
  ShareEventPayload,
  SharePermission,
  StatelessShareEventAction,
  StatelessShareMessage,
} from '@markdawn/shared';
import { COLLAB_TERMINAL_REASONS, shouldApplyPermissionSnapshot } from '@markdawn/shared';
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
  accessRevision?: string;
  sessionToken?: string;
};

type PermissionState = {
  permission: SharePermission | null;
  accessRevision: string;
};

function sendPermissionSnapshot(
  connection: ReturnType<Document['getConnections']>[number],
  ctx: ConnectionContext,
  state: PermissionState,
): boolean {
  const currentPermission = clientPermission(
    typeof ctx.permission === 'string' ? ctx.permission : undefined,
  );
  if (
    !shouldApplyPermissionSnapshot(
      ctx.accessRevision
        ? { permission: currentPermission ?? null, accessRevision: ctx.accessRevision }
        : null,
      state,
    )
  ) {
    return false;
  }
  ctx.permission = state.permission;
  ctx.accessRevision = state.accessRevision;
  connection.sendStateless(
    JSON.stringify({
      type: 'permission_snapshot',
      permission: state.permission,
      accessRevision: state.accessRevision,
    } satisfies PermissionSnapshotMessage),
  );
  return true;
}

function bumpShareAccessMetaVersion(server: Server, userIds: Iterable<string>): void {
  for (const userId of new Set(userIds)) {
    const metaDocument = server.hocuspocus?.documents?.get(`page-meta:${userId}`) as
      | Document
      | undefined;
    if (!metaDocument) continue;
    metaDocument.transact(() => {
      const versions = metaDocument.getMap<number>('accessVersion');
      versions.set('access', (versions.get('access') ?? 0) + 1);
    });
  }
}

function sendWorkspaceMembershipCompatibilityEvent(
  server: Server,
  userIds: Iterable<string>,
  event: Pick<WorkspaceEventPayload, 'action' | 'ownerId'>,
): void {
  const message = JSON.stringify({
    type: 'workspace_membership_event',
    action: event.action,
    ownerId: event.ownerId,
    // Older clients use this stateless event. New clients rely on the durable
    // accessVersion update and skip the duplicate query invalidation.
    refreshViaAccessVersion: true,
  });
  for (const userId of new Set(userIds)) {
    const metaDocument = server.hocuspocus?.documents?.get(`page-meta:${userId}`) as
      | Document
      | undefined;
    for (const connection of metaDocument?.getConnections() ?? []) {
      connection.sendStateless(message);
    }
  }
}

async function getAnonymousPagePermission(pool: Pool, pageId: string): Promise<PermissionState> {
  const result = await pool.query<{ permission: string | null; access_revision: string }>(
    `SELECT get_public_page_permission($1) AS permission,
            get_page_access_revision($1)::text AS access_revision`,
    [pageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Missing anonymous permission revision');
  return {
    permission: clientPermission(row.permission ?? undefined) ?? null,
    accessRevision: row.access_revision,
  };
}

async function getAuthenticatedPagePermissions(
  pool: Pool,
  pageId: string,
  userIds: string[],
): Promise<Map<string, PermissionState>> {
  if (userIds.length === 0) return new Map();

  const result = await pool.query<{
    user_id: string;
    permission: string | null;
    access_revision: string;
  }>(
    `WITH requested_users AS (
       SELECT DISTINCT unnest($2::uuid[]) AS user_id
     )
     SELECT requested_users.user_id, access.permission,
            get_page_access_revision($1)::text AS access_revision
     FROM requested_users
     LEFT JOIN LATERAL get_effective_page_permission(
       $1,
       requested_users.user_id
     ) access ON true`,
    [pageId, userIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.user_id,
      {
        permission: clientPermission(row.permission ?? undefined) ?? null,
        accessRevision: row.access_revision,
      },
    ]),
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
  metaUserIds?: Set<string>,
  advertisedAction?: ShareEventPayload['action'],
  advertisedPermission?: SharePermission,
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
      : Promise.resolve<PermissionState>({ permission: null, accessRevision: '0' }),
  ]);

  if (authenticatedResult.status === 'fulfilled' && authenticatedUserIds.length > 0) {
    if (metaUserIds) {
      for (const userId of authenticatedUserIds) metaUserIds.add(userId);
    } else {
      bumpShareAccessMetaVersion(server, authenticatedUserIds);
    }
  }

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
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }

    const state = user.isAnonymous
      ? (permissionResult.value as PermissionState)
      : (permissionResult.value as Map<string, PermissionState>).get(user.id);
    if (!state) {
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }
    const previousPermission = typeof ctx.permission === 'string' ? ctx.permission : undefined;
    if (!sendPermissionSnapshot(connection, ctx, state)) {
      logger.debug(
        `[share] ignored stale permission snapshot for user=${user.id} on page=${pageId}`,
      );
      continue;
    }
    const permission = state.permission;
    const canonicalMessage =
      message === undefined || advertisedAction === undefined
        ? message
        : permission === null
          ? advertisedAction === 'revoke'
            ? message
            : undefined
          : (advertisedAction === 'grant' || advertisedAction === 'update') &&
              advertisedPermission === permission
            ? message
            : undefined;
    if (!permission) {
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'revoke',
          ...(canonicalMessage !== undefined && { message: canonicalMessage }),
        } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
      logger.info(
        `[share] revoked ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page ${pageId} after permission recompute`,
      );
      affectedCount++;
      continue;
    }

    const isReadOnly = permission === 'view';
    if (connection.readOnly === isReadOnly && previousPermission === permission) {
      if (canonicalMessage !== undefined) {
        connection.sendStateless(
          JSON.stringify({
            type: 'share_event',
            action: 'update',
            permission,
            message: canonicalMessage,
          } satisfies StatelessShareMessage),
        );
        affectedCount++;
        continue;
      }
      logger.debug(
        `[share] skipping user=${user.id} on page ${pageId} (recomputed permission unchanged: ${permission})`,
      );
      continue;
    }

    connection.readOnly = isReadOnly;
    connection.sendStateless(
      JSON.stringify({
        type: 'share_event',
        action: 'update',
        permission,
        ...(canonicalMessage !== undefined && { message: canonicalMessage }),
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
 * Periodically revalidate active page rooms as a fail-safe for missed access
 * notifications and login-session expiry. Requests are batched independently
 * of the number of open sockets.
 */
export async function revalidateActivePageConnections(
  server: Server,
  pool: Pool,
  logger: Logger,
): Promise<number> {
  const pageCandidates: Array<{
    pageId: string;
    connection: ReturnType<Document['getConnections']>[number];
    ctx: ConnectionContext;
  }> = [];
  const metaCandidates: Array<{
    connection: ReturnType<Document['getConnections']>[number];
    ctx: ConnectionContext;
  }> = [];

  for (const [documentName, document] of server.hocuspocus?.documents ?? []) {
    for (const connection of (document as Document).getConnections()) {
      const ctx = connection.context as ConnectionContext | undefined;
      if (!ctx?.user) continue;
      if (PAGE_ID_PATTERN.test(documentName)) {
        pageCandidates.push({ pageId: documentName, connection, ctx });
      } else if (documentName.startsWith('page-meta:') && ctx.user.isAnonymous !== true) {
        metaCandidates.push({ connection, ctx });
      }
    }
  }
  if (pageCandidates.length === 0 && metaCandidates.length === 0) return 0;

  const authenticatedPairs = new Map<
    string,
    { pageId: string; userId: string; sessionToken: string | null }
  >();
  const anonymousPageIds = new Set<string>();
  for (const { pageId, ctx } of pageCandidates) {
    const user = ctx.user;
    if (!user) continue;
    if (user.isAnonymous === true) {
      anonymousPageIds.add(pageId);
    } else {
      const sessionToken = ctx.sessionToken ?? null;
      authenticatedPairs.set(`${pageId}:${user.id}:${sessionToken ?? ''}`, {
        pageId,
        userId: user.id,
        sessionToken,
      });
    }
  }

  const pairs = Array.from(authenticatedPairs.values());
  const anonymousIds = Array.from(anonymousPageIds);
  const authenticatedPromise =
    pairs.length === 0
      ? Promise.resolve(new Map<string, PermissionState>())
      : pool
          .query<{
            page_id: string;
            user_id: string;
            session_token: string | null;
            permission: string | null;
            access_revision: string;
          }>(
            `with requested as (
               select *
               from unnest($1::uuid[], $2::uuid[], $3::text[])
                 as pair(page_id, user_id, session_token)
             )
             select requested.page_id, requested.user_id, requested.session_token,
                    case
                      when requested.session_token is null or exists (
                        select 1 from sessions
                        where token = requested.session_token
                          and user_id = requested.user_id
                          and expires_at > statement_timestamp()
                      ) then access.permission
                      else null
                    end as permission,
                    get_page_access_revision(requested.page_id)::text as access_revision
             from requested
             left join lateral get_effective_page_permission(
               requested.page_id,
               requested.user_id
             ) access on true`,
            [
              pairs.map((pair) => pair.pageId),
              pairs.map((pair) => pair.userId),
              pairs.map((pair) => pair.sessionToken),
            ],
          )
          .then(
            (result) =>
              new Map(
                result.rows.map((row) => [
                  `${row.page_id}:${row.user_id}:${row.session_token ?? ''}`,
                  {
                    permission: clientPermission(row.permission ?? undefined) ?? null,
                    accessRevision: row.access_revision,
                  },
                ]),
              ),
          );
  const anonymousPromise =
    anonymousIds.length === 0
      ? Promise.resolve(new Map<string, PermissionState>())
      : pool
          .query<{ page_id: string; permission: string | null; access_revision: string }>(
            `with requested as (
               select distinct unnest($1::uuid[]) as page_id
             )
             select requested.page_id,
                    get_public_page_permission(requested.page_id) as permission,
                    get_page_access_revision(requested.page_id)::text as access_revision
             from requested`,
            [anonymousIds],
          )
          .then(
            (result) =>
              new Map(
                result.rows.map((row) => [
                  row.page_id,
                  {
                    permission: clientPermission(row.permission ?? undefined) ?? null,
                    accessRevision: row.access_revision,
                  },
                ]),
              ),
          );

  const metaSessions = new Map<string, { userId: string; sessionToken: string | null }>();
  for (const { ctx } of metaCandidates) {
    const userId = ctx.user?.id;
    if (!userId) continue;
    const sessionToken = ctx.sessionToken ?? null;
    metaSessions.set(`${userId}:${sessionToken ?? ''}`, { userId, sessionToken });
  }
  const sessionRequests = Array.from(metaSessions.values());
  const metaSessionPromise =
    sessionRequests.length === 0
      ? Promise.resolve(new Map<string, { valid: boolean; accessRevision: string }>())
      : pool
          .query<{
            user_id: string;
            session_token: string | null;
            valid: boolean;
            access_revision: string;
          }>(
            `with requested as (
               select *
               from unnest($1::uuid[], $2::text[]) as item(user_id, session_token)
             )
             select requested.user_id, requested.session_token,
                    (requested.session_token is null or exists (
                      select 1 from sessions
                      where token = requested.session_token
                        and user_id = requested.user_id
                        and expires_at > statement_timestamp()
                    )) as valid,
                    coalesce((select max(version) from workspace_access_versions), 0)::text as access_revision
             from requested`,
            [
              sessionRequests.map((request) => request.userId),
              sessionRequests.map((request) => request.sessionToken),
            ],
          )
          .then(
            (result) =>
              new Map(
                result.rows.map((row) => [
                  `${row.user_id}:${row.session_token ?? ''}`,
                  { valid: row.valid, accessRevision: row.access_revision },
                ]),
              ),
          );

  const [authenticatedResult, anonymousResult, metaSessionResult] = await Promise.allSettled([
    authenticatedPromise,
    anonymousPromise,
    metaSessionPromise,
  ]);
  let affectedCount = 0;
  for (const { pageId, connection, ctx } of pageCandidates) {
    const user = ctx.user;
    if (!user) continue;
    const result = user.isAnonymous ? anonymousResult : authenticatedResult;
    if (result.status === 'rejected') {
      logger.error(
        `[access] failed to revalidate ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page=${pageId}: ${result.reason}`,
      );
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }

    const state = user.isAnonymous
      ? (result.value as Map<string, PermissionState>).get(pageId)
      : (result.value as Map<string, PermissionState>).get(
          `${pageId}:${user.id}:${ctx.sessionToken ?? ''}`,
        );
    if (!state) {
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }
    const previousPermission = ctx.permission;
    if (!sendPermissionSnapshot(connection, ctx, state)) continue;
    const permission = state.permission;
    if (!permission) {
      connection.sendStateless(
        JSON.stringify({ type: 'share_event', action: 'revoke' } satisfies StatelessShareMessage),
      );
      connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
      logger.info(
        `[access] revoked ${user.isAnonymous ? 'anonymous' : 'user'}=${user.id} on page=${pageId}`,
      );
      affectedCount++;
      continue;
    }

    const readOnly = permission === 'view';
    if (connection.readOnly === readOnly && previousPermission === permission) continue;
    connection.readOnly = readOnly;
    connection.sendStateless(
      JSON.stringify({
        type: 'share_event',
        action: 'update',
        permission,
      } satisfies StatelessShareMessage),
    );
    affectedCount++;
  }

  for (const { connection, ctx } of metaCandidates) {
    const userId = ctx.user?.id;
    if (!userId) continue;
    if (metaSessionResult.status === 'rejected') {
      logger.error(`[access] failed to revalidate metadata session for user=${userId}`);
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }
    const sessionState = metaSessionResult.value.get(`${userId}:${ctx.sessionToken ?? ''}`);
    if (!sessionState) {
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
      affectedCount++;
      continue;
    }
    sendPermissionSnapshot(connection, ctx, {
      permission: null,
      accessRevision: sessionState.accessRevision,
    });
    if (sessionState.valid) continue;
    connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.SESSION_EXPIRED });
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

  // For public-access events (no targetUserId), pre-fetch account permissions
  // so every signed-in connection can retain or fall back to its account access.
  const isPublicAccessEvent = targetUserId === undefined;
  let basePermissions: Map<string, SharePermission | 'edit'> | undefined;
  let basePermissionsFailed = false;
  if (isPublicAccessEvent && pool) {
    try {
      const result = await pool.query(
        `SELECT user_id, permission
         FROM get_page_base_permissions($1)`,
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

  // If permissions cannot be verified after a public-access change, disconnect every
  // affected session. Reconnection will run the normal authentication path.
  if (basePermissionsFailed) {
    logger.warn(
      `[share] base permissions unavailable for page ${pageId}, closing active connections`,
    );
    for (const connection of connections) {
      connection.close({
        code: 4500,
        reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
      });
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

    // --- Public-access events: handle authenticated users ---
    if (isPublicAccessEvent && !ctx.user.isAnonymous) {
      const basePerm = basePermissions?.get(ctx.user.id);

      if (action === 'revoke') {
        // Account users retain their independent access, including a downgrade
        // from public Edit to account View. Users without account access close.
        if (basePerm !== undefined) {
          const currentPermission = clientPermission(
            (connection.context as { permission?: string }).permission,
          );
          const retainedPermission =
            currentPermission === 'admin' && basePerm === 'edit' ? 'admin' : basePerm;
          const isReadOnly = retainedPermission === 'view';
          if (connection.readOnly === isReadOnly && currentPermission === retainedPermission) {
            logger.debug(
              `[share] public revoke leaves account permission unchanged for user=${ctx.user.id} (base=${retainedPermission})`,
            );
            continue;
          }
          connection.readOnly = isReadOnly;
          (connection.context as Record<string, unknown>).permission = retainedPermission;
          connection.sendStateless(
            JSON.stringify({
              type: 'share_event',
              action: 'update',
              permission: retainedPermission,
              ...(message !== undefined && { message }),
            } satisfies StatelessShareMessage),
          );
          logger.debug(
            `[share] public revoke restored account permission for user=${ctx.user.id} (base=${retainedPermission})`,
          );
          affectedCount++;
          continue;
        }
        connection.sendStateless(
          JSON.stringify({
            type: 'share_event',
            action: 'revoke',
            ...(message !== undefined && { message }),
          } satisfies StatelessShareMessage),
        );
        connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
        logger.info(`[share] revoked public-only user=${ctx.user.id} on page ${pageId}`);
        affectedCount++;
        continue;
      }

      // grant / update: compute effective permission for EVERY connection
      // (account and public-only alike) based on account + public permission.
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
        `[share] set ${isReadOnly ? 'read-only' : 'editable'} for user=${ctx.user.id} on page ${pageId} (base=${basePerm ?? 'none'} public=${permission} effective=${effectivePermission})`,
      );
      affectedCount++;
      continue;
    }

    // --- Targeted account-grant events or anonymous public-access events ---
    if (!isAffectedAnonymous && !isAffectedUser) continue;
    affectedCount++;

    if (action === 'revoke') {
      // For targeted revokes, ask the canonical permission function whether
      // another valid path remains. Null and query failures both fail closed.
      if (isTargeted && pool) {
        try {
          const permResult = await pool.query(
            `SELECT permission
             FROM get_effective_page_permission($1, $2)`,
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
      connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
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
      // For targeted account-grant events, always send notification even if
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
 * - `targetUserId = undefined` → affects public-access connections
 * - `targetUserId = string`    → affects that specific account grant
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

  const metaUserIds = new Set(payload.metaUserIds ?? []);
  if (targetUserId) metaUserIds.add(targetUserId);

  if (payload.metaOnly === true) {
    // Public-access visits change dashboard/list visibility, but they do not
    // change any already-open page connection's effective permission. Keep
    // this notification targeted and bounded: only invalidate the named
    // users' durable meta rooms, without folder fanout or page revalidation.
    bumpShareAccessMetaVersion(server, metaUserIds);
    logger.debug(
      `[share] processed metadata-only invalidation for ${entityType} ${entityId}: ${metaUserIds.size} user(s)`,
    );
    return;
  }

  try {
    // For folders, intersect the subtree with active page rooms before doing
    // any permission work. Inactive pages rebuild authorization from PostgreSQL
    // when they are opened and must not block live revocations.
    if (entityType === 'folder') {
      const activePageIds = Array.from(server.hocuspocus?.documents?.keys() ?? []).filter(
        (pageId) => PAGE_ID_PATTERN.test(pageId),
      );
      if (activePageIds.length === 0) {
        logger.debug(`[share] no active pages for folder ${entityId}, skipping`);
        return;
      }

      let pageIds: string[] = [];
      if (pool) {
        try {
          const result = await pool.query(
            `SELECT p.id FROM pages p
          WHERE p.id = ANY($2::uuid[])
            AND p.parent_id IN (
              SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1
            )
            AND p.is_deleted = false`,
            [entityId, activePageIds],
          );
          pageIds = result.rows.map((r: { id: string }) => r.id);
        } catch (err) {
          logger.error(`[share] failed to query pages in folder ${entityId}: ${err}`);
          // The subtree lookup failed, so revalidate matching users on every
          // active page. Each per-page check still fails closed, while users
          // whose effective access can be verified remain connected.
          for (const activePageId of activePageIds) {
            await recomputePageConnections(
              server,
              activePageId,
              pool,
              logger,
              message,
              targetUserId,
              metaUserIds,
              action,
              rawPermission,
            );
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
            ? await recomputePageConnections(
                server,
                pageId,
                pool,
                logger,
                message,
                targetUserId,
                metaUserIds,
                action,
                rawPermission,
              )
            : action === 'recompute'
              ? await recomputePageConnections(
                  server,
                  pageId,
                  pool,
                  logger,
                  message,
                  targetUserId,
                  metaUserIds,
                  action,
                  rawPermission,
                )
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
      const affectedCount = await recomputePageConnections(
        server,
        entityId,
        pool,
        logger,
        message,
        targetUserId,
        metaUserIds,
        action,
        rawPermission,
      );
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
  } finally {
    bumpShareAccessMetaVersion(server, metaUserIds);
  }
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

  const metaUserIds = new Set([ownerId, memberId]);

  try {
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
      logger.error(
        `[workspace] failed to query active pages for workspace owner ${ownerId}: ${err}`,
      );
      // The workspace could not be identified, so revalidate only this member
      // on active pages. Each recomputation remains fail closed.
      for (const activePageId of activePageIds) {
        await recomputePageConnections(
          server,
          activePageId,
          pool,
          logger,
          message,
          memberId,
          metaUserIds,
        );
      }
      return;
    }

    if (pageIds.length === 0) {
      logger.debug(`[workspace] no matching active pages for workspace owner ${ownerId}, skipping`);
      return;
    }

    let permissions: Map<string, PermissionState>;
    let permissionQueryFailed = false;
    try {
      const permissionResult = await pool.query<{
        page_id: string;
        permission: string | null;
        access_revision: string;
      }>(
        `WITH requested_pages AS (
         SELECT unnest($1::uuid[]) AS page_id
       )
       SELECT requested_pages.page_id, access.permission,
              get_page_access_revision(requested_pages.page_id)::text AS access_revision
       FROM requested_pages
       LEFT JOIN LATERAL get_effective_page_permission(
         requested_pages.page_id,
         $2
       ) access ON true`,
        [pageIds, memberId],
      );
      permissions = new Map(
        permissionResult.rows.map((row) => [
          row.page_id,
          {
            permission: clientPermission(row.permission ?? undefined) ?? null,
            accessRevision: row.access_revision,
          },
        ]),
      );
    } catch (err) {
      permissionQueryFailed = true;
      logger.error(`[workspace] failed to batch permissions for user=${memberId}: ${err}`);
      permissions = new Map();
    }

    for (const pageId of pageIds) {
      const activeDoc = server.hocuspocus?.documents?.get(pageId) as Document | undefined;
      if (!activeDoc) continue;
      const state = permissions.get(pageId);

      for (const connection of activeDoc.getConnections()) {
        const ctx = connection.context as ConnectionContext | undefined;
        if (ctx?.user?.id !== memberId) continue;

        if (!state) {
          connection.close({
            code: 4500,
            reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
          });
          logger.warn(
            `[workspace] could not verify user=${memberId} on page ${pageId} (${action})`,
          );
          continue;
        }
        if (!sendPermissionSnapshot(connection, ctx, state)) continue;
        const permission = state.permission;
        if (!permission) {
          if (permissionQueryFailed) {
            connection.close({
              code: 4500,
              reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
            });
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
            connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
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
  } finally {
    bumpShareAccessMetaVersion(server, metaUserIds);
    sendWorkspaceMembershipCompatibilityEvent(server, metaUserIds, { action, ownerId });
  }
}
