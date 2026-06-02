import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit' | 'admin';

type AccessMode = 'view' | 'edit';

type AccessRow = {
  permission: SharePermission;
};

const permissionRank = (permission: SharePermission) =>
  permission === 'admin' ? 3 : permission === 'edit' ? 2 : 1;
const hasRequiredPermission = (permission: SharePermission, mode: AccessMode) => {
  return permissionRank(permission) >= permissionRank(mode);
};

export const parsePermission = (value: unknown): SharePermission => {
  if (value === 'admin') return 'admin';
  if (value === 'edit') return 'edit';
  return 'view';
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

  const result = await pool.query(
    `
      with recursive folder_ancestors as (
        select f.id, f.parent_id, f.is_access_restricted
        from pages p
        join folders f on f.id = p.parent_id
        where p.id = $1
        union all
        select parent.id, parent.parent_id, parent.is_access_restricted
        from folders parent
        join folder_ancestors child on child.parent_id = parent.id
      ),
      restricted_check as (
        select exists(select 1 from folder_ancestors where is_access_restricted = true) as blocked
      )
      select permission
      from (
        -- Direct email invites on the page
        select permission, 1 as src
        from shares s
        where s.entity_type = 'page' and s.entity_id = $1 and s.recipient_user_id = $2
          and (s.expires_at is null or s.expires_at > now())

        union all

        -- Email invites on ancestor folders
        select permission, 2 as src
        from shares s
        where s.entity_type = 'folder' and s.entity_id in (select id from folder_ancestors) and s.recipient_user_id = $2
          and (s.expires_at is null or s.expires_at > now())

        union all

        -- Link share on the page (if public)
        select permission, 3 as src
        from shares s
        where s.entity_type = 'page' and s.entity_id = $1 and s.token is not null
          and (s.expires_at is null or s.expires_at > now())
          and exists (select 1 from pages where id = $1 and is_public = true)

        union all

        -- Workspace membership (blocked if any ancestor folder is restricted)
        select
          case when wm.role = 'admin' then 'admin' else 'edit' end,
          4 as src
        from workspace_members wm
        join pages p on p.id = $1
        where wm.workspace_owner_id = p.created_by and wm.member_id = $2
          and not (select blocked from restricted_check)
      ) perms
      order by
        case permission when 'admin' then 3 when 'edit' then 2 else 1 end desc,
        src asc
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
  // Check owner of the folder
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
        select id, parent_id, is_access_restricted from folders where id = $1
        union all
        select parent.id, parent.parent_id, parent.is_access_restricted
        from folders parent
        join folder_ancestors child on child.parent_id = parent.id
      ),
      restricted_check as (
        select exists(select 1 from folder_ancestors where is_access_restricted = true) as blocked
      )
      select permission
      from (
        -- Direct folder invites on ancestors (including the folder itself)
        select permission, 1 as src
        from shares s
        where s.recipient_user_id = $2
          and s.entity_type = 'folder'
          and s.entity_id in (select id from folder_ancestors)
          and (s.expires_at is null or s.expires_at > now())

        union all

        -- Workspace membership (blocked if any ancestor folder is restricted)
        select
          case when wm.role = 'admin' then 'admin' else 'edit' end,
          4 as src
        from workspace_members wm
        join folders f on f.id = $1
        where wm.workspace_owner_id = f.created_by and wm.member_id = $2
          and not (select blocked from restricted_check)
      ) perms
      order by
        case permission when 'admin' then 3 when 'edit' then 2 else 1 end desc,
        src asc
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

// Helper to ensure the user can administer an entity: owner or has admin permission.
// This is stricter than ensureCanManageEntity — it gates invite creation, permission
// changes, and removing others from an entity.
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
  throw new HTTPException(403, { message: 'Forbidden' });
};
