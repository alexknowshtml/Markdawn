import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit';

type AccessMode = 'view' | 'edit';

type AccessRow = {
  permission: SharePermission;
};

const permissionRank = (permission: SharePermission) => (permission === 'edit' ? 2 : 1);
const hasRequiredPermission = (permission: SharePermission, mode: AccessMode) => {
  return permissionRank(permission) >= permissionRank(mode);
};

export const parsePermission = (value: unknown): SharePermission => {
  return value === 'edit' ? 'edit' : 'view';
};

export const parseEntityType = (value: string): ShareEntityType => {
  if (value === 'folder' || value === 'page') {
    return value;
  }
  throw new HTTPException(400, { message: 'Invalid entity type' });
};

// New access helpers that do NOT rely on workspaces.
// These check ownership (created_by) first, then explicit shares on the entity (or ancestor folders for pages).

export const ensurePageAccess = async (
  pageId: string,
  userId: string,
  mode: AccessMode = 'view',
) => {
  // Check owner
  const ownerRes = await pool.query(
    'select created_by from pages where id = $1 and is_deleted = false limit 1',
    [pageId],
  );
  const ownerRow = ownerRes.rows[0] as { created_by?: string } | undefined;
  if (!ownerRow) throw new HTTPException(404, { message: 'Page not found' });
  if (ownerRow.created_by === userId) {
    return { hasAccess: true, fullAccess: true, permission: 'edit' as SharePermission };
  }

  // Check shares on page or ancestor folders
  const result = await pool.query(
    `
      with recursive folder_ancestors as (
        select f.id, f.parent_id
        from pages p
        join folders f on f.id = p.parent_id
        where p.id = $1
        union all
        select parent.id, parent.parent_id
        from folders parent
        join folder_ancestors child on child.parent_id = parent.id
      )
      select permission
      from shares s
      where s.recipient_user_id = $2
        and (
          (s.entity_type = 'page' and s.entity_id = $1)
          or (s.entity_type = 'folder' and s.entity_id in (select id from folder_ancestors))
        )
      order by case when permission = 'edit' then 0 else 1 end
      limit 1
    `,
    [pageId, userId],
  );
  const share = result.rows[0] as AccessRow | undefined;
  if (!share || !hasRequiredPermission(share.permission, mode)) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  return { hasAccess: true, fullAccess: false, permission: share.permission };
};

export const ensureFolderAccess = async (
  folderId: string,
  userId: string,
  mode: AccessMode = 'view',
) => {
  // Check owner of the folder by looking for any page that references it? Prefer folders.created_by if available.
  const ownerRes = await pool.query(
    'select created_by from folders where id = $1 and is_deleted = false limit 1',
    [folderId],
  );
  const ownerRow = ownerRes.rows[0] as { created_by?: string } | undefined;
  if (!ownerRow) throw new HTTPException(404, { message: 'Folder not found' });
  if (ownerRow.created_by === userId) {
    return { hasAccess: true, fullAccess: true, permission: 'edit' as SharePermission };
  }

  const result = await pool.query(
    `
      with recursive folder_ancestors as (
        select id, parent_id from folders where id = $1
        union all
        select parent.id, parent.parent_id
        from folders parent
        join folder_ancestors child on child.parent_id = parent.id
      )
      select permission
      from shares s
      where s.recipient_user_id = $2
        and s.entity_type = 'folder'
        and s.entity_id in (select id from folder_ancestors)
      order by case when permission = 'edit' then 0 else 1 end
      limit 1
    `,
    [folderId, userId],
  );
  const share = result.rows[0] as AccessRow | undefined;
  if (!share || !hasRequiredPermission(share.permission, mode)) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  return { hasAccess: true, fullAccess: false, permission: share.permission };
};

// Helper to ensure the user can manage (edit) an entity: owner or has edit share
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
