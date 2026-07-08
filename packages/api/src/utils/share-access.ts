import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit' | 'admin';

type AccessMode = 'view' | 'edit';

const permissionRank = (permission: SharePermission) =>
  permission === 'admin' ? 3 : permission === 'edit' ? 2 : 1;
const hasRequiredPermission = (permission: SharePermission, mode: AccessMode) => {
  return permissionRank(permission) >= permissionRank(mode);
};

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
) => {
  const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
    pageId,
    userId,
  ]);
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
    throw new HTTPException(403, { message: 'You need edit access to modify this page' });
  }

  return { hasAccess: true, fullAccess: false, permission };
};

export const ensureFolderAccess = async (
  folderId: string,
  userId: string,
  mode: AccessMode = 'view',
) => {
  const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
    folderId,
    userId,
  ]);
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
    throw new HTTPException(403, { message: 'You need edit access to modify this folder' });
  }

  return { hasAccess: true, fullAccess: false, permission };
};

export const ensureCanManageEntity = async (
  entityType: 'page' | 'folder',
  entityId: string,
  userId: string,
) => {
  if (entityType === 'page') {
    const access = await ensurePageAccess(entityId, userId, 'edit');
    return access;
  }
  const access = await ensureFolderAccess(entityId, userId, 'edit');
  return access;
};

export const ensureCanAdminEntity = async (
  entityType: 'page' | 'folder',
  entityId: string,
  userId: string,
) => {
  const access =
    entityType === 'page'
      ? await ensurePageAccess(entityId, userId, 'edit')
      : await ensureFolderAccess(entityId, userId, 'edit');

  if (access.fullAccess || access.permission === 'admin') {
    return { ...access, permission: 'admin' as SharePermission };
  }
  throw new HTTPException(403, { message: `You need admin access to manage this ${entityType}` });
};
