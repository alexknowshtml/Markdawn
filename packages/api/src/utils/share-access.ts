import { HTTPException } from 'hono/http-exception';
import { executeQuery, type QueryExecutor, query } from '../db/query';

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit' | 'admin';

type AccessMode = 'view' | 'edit' | 'admin';

const permissionRank = (permission: SharePermission) =>
  permission === 'admin' ? 3 : permission === 'edit' ? 2 : 1;
const hasRequiredPermission = (permission: SharePermission, mode: AccessMode) => {
  return permissionRank(permission) >= permissionRank(mode);
};

const accessModeLabel = (mode: AccessMode) =>
  mode === 'admin' ? 'admin' : mode === 'edit' ? 'edit' : 'view';

export const parsePermission = (value: unknown): SharePermission => {
  if (value === 'admin') return 'admin';
  if (value === 'edit') return 'edit';
  if (value === 'view') return 'view';
  throw new HTTPException(400, { message: 'Invalid permission' });
};

export const parseLinkPermission = (value: unknown): AccessMode => {
  if (value === 'edit') return 'edit';
  if (value === 'view') return 'view';
  throw new HTTPException(400, { message: 'Invalid link permission' });
};

export const parseEntityType = (value: string): ShareEntityType => {
  if (value === 'folder' || value === 'page') {
    return value;
  }
  throw new HTTPException(400, { message: 'Invalid entity type' });
};

export const ensurePageAccess = async (
  pageId: string,
  userId: string,
  mode: AccessMode = 'view',
  executor?: QueryExecutor,
) => {
  const statement = 'SELECT * FROM get_effective_page_permission_at($1, $2, statement_timestamp())';
  const parameters = [pageId, userId];
  const result = executor
    ? await executeQuery(executor, statement, parameters)
    : await query(statement, parameters);
  const row = result.rows[0] as { permission: string | null; full_access: boolean } | undefined;

  if (!row || row.permission === null) {
    throw new HTTPException(403, { message: "You don't have access to this page" });
  }

  const permission = row.permission as SharePermission;
  const fullAccess = row.full_access;

  if (fullAccess) {
    return { hasAccess: true, fullAccess: true, permission: 'edit' as SharePermission };
  }

  if (!hasRequiredPermission(permission, mode)) {
    throw new HTTPException(403, {
      message: `You need ${accessModeLabel(mode)} access to access this page`,
    });
  }

  return { hasAccess: true, fullAccess: false, permission };
};

export const ensureFolderAccess = async (
  folderId: string,
  userId: string,
  mode: AccessMode = 'view',
  executor?: QueryExecutor,
) => {
  const statement =
    'SELECT * FROM get_effective_folder_permission_at($1, $2, statement_timestamp())';
  const parameters = [folderId, userId];
  const result = executor
    ? await executeQuery(executor, statement, parameters)
    : await query(statement, parameters);
  const row = result.rows[0] as { permission: string | null; full_access: boolean } | undefined;

  if (!row || row.permission === null) {
    throw new HTTPException(403, { message: "You don't have access to this folder" });
  }

  const permission = row.permission as SharePermission;
  const fullAccess = row.full_access;

  if (fullAccess) {
    return { hasAccess: true, fullAccess: true, permission: 'edit' as SharePermission };
  }

  if (!hasRequiredPermission(permission, mode)) {
    throw new HTTPException(403, {
      message: `You need ${accessModeLabel(mode)} access to access this folder`,
    });
  }

  return { hasAccess: true, fullAccess: false, permission };
};

export const lockWorkspaceAccess = async (
  executor: QueryExecutor,
  workspaceOwnerId: string,
): Promise<void> => {
  await executeQuery(executor, 'select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `workspace-access:${workspaceOwnerId}`,
  ]);
};

export const lockWorkspaceAccessMutation = async (
  executor: QueryExecutor,
  workspaceOwnerId: string,
): Promise<void> => {
  await lockWorkspaceAccess(executor, workspaceOwnerId);
  await executeQuery(
    executor,
    `insert into workspace_access_versions (workspace_owner_id, version)
     values ($1, nextval('workspace_access_revision_seq'))
     on conflict (workspace_owner_id) do update
     set version = nextval('workspace_access_revision_seq')`,
    [workspaceOwnerId],
  );
};

const resolveEntityOwnerIds = async (
  executor: QueryExecutor,
  entities: ReadonlyArray<{ entityType: ShareEntityType; entityId: string }>,
): Promise<string[]> => {
  const resolvedOwnerIds: string[] = [];
  for (const { entityType, entityId } of entities) {
    const statement =
      entityType === 'page'
        ? `select coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id
           from pages p
           where p.id = $1 and p.is_deleted = false`
        : `select get_root_folder_owner(f.id) as owner_id
           from folders f
           where f.id = $1 and f.is_deleted = false`;
    const result = await executeQuery(executor, statement, [entityId]);
    const row = result.rows[0] as { owner_id: string | null } | undefined;
    if (!row) {
      throw new HTTPException(404, {
        message: entityType === 'page' ? 'Page not found' : 'Folder not found',
      });
    }
    if (!row.owner_id) {
      throw new HTTPException(409, { message: 'Entity owner could not be determined' });
    }
    resolvedOwnerIds.push(row.owner_id);
  }
  return resolvedOwnerIds;
};

const lockStableEntityAccess = async (
  executor: QueryExecutor,
  entities: ReadonlyArray<{ entityType: ShareEntityType; entityId: string }>,
  additionalWorkspaceOwnerIds: readonly string[],
  lockWorkspace: (executor: QueryExecutor, workspaceOwnerId: string) => Promise<void>,
): Promise<string[]> => {
  const ownerIds = await resolveEntityOwnerIds(executor, entities);
  const lockedOwnerIds = [...new Set([...ownerIds, ...additionalWorkspaceOwnerIds])].sort();
  for (const ownerId of lockedOwnerIds) {
    await lockWorkspace(executor, ownerId);
  }

  // Supported organization routes never change an entity's workspace owner,
  // but re-resolve after the advisory locks so a future route or direct SQL
  // writer cannot make us continue under only a stale workspace key.
  const currentOwnerIds = await resolveEntityOwnerIds(executor, entities);
  const lockedOwnerIdSet = new Set(lockedOwnerIds);
  if (currentOwnerIds.some((ownerId) => !lockedOwnerIdSet.has(ownerId))) {
    throw new HTTPException(409, {
      message: 'Entity workspace changed while acquiring access lock; retry the request',
    });
  }
  return currentOwnerIds;
};

export const lockEntityAccesses = async (
  executor: QueryExecutor,
  entities: ReadonlyArray<{ entityType: ShareEntityType; entityId: string }>,
  additionalWorkspaceOwnerIds: readonly string[] = [],
): Promise<string[]> => {
  return lockStableEntityAccess(
    executor,
    entities,
    additionalWorkspaceOwnerIds,
    lockWorkspaceAccess,
  );
};

export const lockEntityAccess = async (
  executor: QueryExecutor,
  entityType: ShareEntityType,
  entityId: string,
): Promise<string> => {
  const ownerIds = await lockEntityAccesses(executor, [{ entityType, entityId }]);
  const ownerId = ownerIds[0];
  if (!ownerId) throw new Error('Entity access lock did not resolve an owner');
  return ownerId;
};

export const lockEntityAccessMutations = async (
  executor: QueryExecutor,
  entities: ReadonlyArray<{ entityType: ShareEntityType; entityId: string }>,
  additionalWorkspaceOwnerIds: readonly string[] = [],
): Promise<string[]> => {
  return lockStableEntityAccess(
    executor,
    entities,
    additionalWorkspaceOwnerIds,
    lockWorkspaceAccessMutation,
  );
};

export const lockEntityAccessMutation = async (
  executor: QueryExecutor,
  entityType: ShareEntityType,
  entityId: string,
): Promise<string> => {
  const ownerIds = await lockEntityAccessMutations(executor, [{ entityType, entityId }]);
  const ownerId = ownerIds[0];
  if (!ownerId) throw new Error('Entity access lock did not resolve an owner');
  return ownerId;
};

export const ensureCanAdminEntity = async (
  entityType: 'page' | 'folder',
  entityId: string,
  userId: string,
  executor?: QueryExecutor,
) => {
  const access =
    entityType === 'page'
      ? await ensurePageAccess(entityId, userId, 'admin', executor)
      : await ensureFolderAccess(entityId, userId, 'admin', executor);

  return { ...access, permission: 'admin' as SharePermission };
};

export const ensureWorkspaceAdmin = async (
  workspaceOwnerId: string,
  userId: string,
  executor?: QueryExecutor,
) => {
  if (workspaceOwnerId === userId) {
    return { fullAccess: true, permission: 'admin' as const };
  }

  const statement = `select role from workspace_members
     where workspace_owner_id = $1 and member_id = $2
     limit 1`;
  const parameters = [workspaceOwnerId, userId];
  const result = executor
    ? await executeQuery(executor, statement, parameters)
    : await query(statement, parameters);
  if (result.rows[0]?.role !== 'admin') {
    throw new HTTPException(403, { message: 'You need admin access to manage this workspace' });
  }

  return { fullAccess: false, permission: 'admin' as const };
};
