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
  const statement = 'SELECT * FROM get_effective_page_permission($1, $2)';
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
  const statement = 'SELECT * FROM get_effective_folder_permission($1, $2)';
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

export const ensureWorkspaceAdmin = async (workspaceOwnerId: string, userId: string) => {
  if (workspaceOwnerId === userId) {
    return { fullAccess: true, permission: 'admin' as const };
  }

  const result = await query(
    `select role from workspace_members
     where workspace_owner_id = $1 and member_id = $2
     limit 1`,
    [workspaceOwnerId, userId],
  );
  if (result.rows[0]?.role !== 'admin') {
    throw new HTTPException(403, { message: 'You need admin access to manage this workspace' });
  }

  return { fullAccess: false, permission: 'admin' as const };
};
