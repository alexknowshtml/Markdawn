import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import type { folders } from '../db';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { ensureCanAdminEntity, ensureFolderAccess } from '../utils/share-access';
import { notifyShareRevoke, notifyShareUpdate } from '../utils/share-notify';

type FolderRow = typeof folders.$inferSelect;
type RawFolderRow = FolderRow & {
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  is_deleted?: boolean | null;
  deleted_at?: Date | null;
  is_public?: boolean | null;
  public_token?: string | null;
  is_access_restricted?: boolean | null;
};

type LinkPermission = 'view' | 'edit';
type FolderLinkAccess = {
  permission: LinkPermission;
  token: string;
};

const foldersRoute = new Hono();
const foldersPublicRoute = new Hono();

foldersRoute.use('*', requireAuth);

const normalizeFolderRow = (row: RawFolderRow): FolderRow => ({
  ...row,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
  isDeleted: row.isDeleted ?? row.is_deleted ?? false,
  deletedAt: row.deletedAt ?? row.deleted_at ?? null,
  isPublic: row.isPublic ?? row.is_public ?? false,
  publicToken: row.publicToken ?? row.public_token ?? null,
  isAccessRestricted: row.isAccessRestricted ?? row.is_access_restricted ?? false,
});

const normalizeLinkPermission = (permission: string | null | undefined): LinkPermission => {
  return permission === 'edit' || permission === 'admin' ? 'edit' : 'view';
};

const getFolderLinkAccess = async (folderId: string): Promise<FolderLinkAccess | null> => {
  const result = await query(
    `
      select
        coalesce(s.permission, 'view') as permission,
        coalesce(s.token, f.public_token, f.id::text) as token
      from folder_closure fc
      join folders f on f.id = fc.ancestor_id and f.is_deleted = false
      left join lateral (
        select permission, token
        from shares
        where entity_type = 'folder'
          and entity_id = f.id
          and token is not null
          and (expires_at is null or expires_at > now())
        order by updated_at desc nulls last
        limit 1
      ) s on true
      where fc.descendant_id = $1
        and f.is_public = true
      order by
        case coalesce(s.permission, 'view')
          when 'admin' then 3
          when 'edit' then 2
          else 1
        end desc,
        fc.depth asc
      limit 1
    `,
    [folderId],
  );

  const row = result.rows[0] as { permission?: string | null; token?: string | null } | undefined;
  if (!row?.token) {
    return null;
  }

  return {
    permission: normalizeLinkPermission(row.permission),
    token: row.token,
  };
};

const getFolderById = async (folderId: string) => {
  const result = await query('select * from folders where id = $1 and is_deleted = false limit 1', [
    folderId,
  ]);
  const row = (result.rows[0] as RawFolderRow | undefined) ?? null;
  return row ? normalizeFolderRow(row) : null;
};

const ensureNoFolderCycle = async (
  folderId: string,
  targetParentId: string | null,
  _userId: string,
) => {
  if (!targetParentId) {
    return;
  }

  // Check if targetParentId is already a descendant of folderId (would create a cycle)
  const result = await query(
    `SELECT 1 FROM folder_closure
     WHERE ancestor_id = $1 AND descendant_id = $2 AND depth > 0`,
    [folderId, targetParentId],
  );
  if (result.rowCount && result.rowCount > 0) {
    throw new HTTPException(400, { message: 'Cannot move folder into its own subtree' });
  }
};

const buildFolderTree = (rows: (FolderRow & { isLostAccess?: boolean })[]) => {
  type FolderNode = FolderRow & { children: FolderNode[]; isLostAccess?: boolean };
  const nodes: FolderNode[] = rows.map((folder) => ({
    ...folder,
    children: [],
  }));
  const map = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    map.set(node.id, node);
  }

  const roots: typeof nodes = [];
  for (const node of nodes) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
};

foldersRoute.get('/tree', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `
      with
      workspace_owners as (
        select workspace_owner_id from workspace_members where member_id = $1
      ),
      shared_folder_descendants as (
        select fc.descendant_id as id
        from shares s
        join folder_closure fc on fc.ancestor_id = s.entity_id
        where s.entity_type = 'folder' and s.recipient_user_id = $1
      ),
      restricted_tree as (
        select fc.descendant_id as id
        from folders f
        join folder_closure fc on fc.ancestor_id = f.id
        where f.is_access_restricted = true and f.is_deleted = false
      ),
      accessible_folders as (
        select f.id, false as is_lost_access
        from folders f
        where f.is_deleted = false
          and (
            get_root_folder_owner(f.id) = $1
            or f.id in (select id from shared_folder_descendants)
            or (get_root_folder_owner(f.id) in (select workspace_owner_id from workspace_owners)
                and f.id not in (select id from restricted_tree))
          )
        union
        select f.id, true as is_lost_access
        from folders f
        where f.is_deleted = false
          and f.id in (select id from restricted_tree)
          and get_root_folder_owner(f.id) in (select workspace_owner_id from workspace_owners)
          and get_root_folder_owner(f.id) != $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'folder' and s.entity_id = f.id and s.recipient_user_id = $1
          )
      )
      select f.*, af.is_lost_access,
        (SELECT permission FROM get_effective_folder_permission(f.id, $1)) as user_permission
      from folders f
      join accessible_folders af on af.id = f.id
      order by f.parent_id nulls first, case when f.parent_id is null then f.updated_at end desc nulls last, f.position asc
    `,
    [user.id],
  );

  return c.json(
    buildFolderTree(
      (
        result.rows as (RawFolderRow & {
          is_lost_access?: boolean;
          user_permission?: string | null;
        })[]
      ).map((row) => ({
        ...normalizeFolderRow(row),
        isLostAccess: row.is_lost_access ?? false,
        userPermission: row.user_permission ?? null,
      })),
    ),
  );
});

foldersRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, name, icon } = body as {
    parentId?: string | null;
    name?: string;
    icon?: string | null;
  };

  const user = c.get('user') as { id: string };

  if (parentId) {
    const parent = await getFolderById(parentId);
    if (!parent) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    if (parent.isDeleted) {
      throw new HTTPException(400, { message: 'Cannot create inside a deleted folder' });
    }
    // ensure user can manage parent
    await ensureFolderAccess(parent.id, user.id, 'edit');
  }

  const positionResult = await query(
    parentId
      ? 'select max(position) as max_position from folders where parent_id = $1 and created_by = $2'
      : 'select max(position) as max_position from folders where parent_id is null and created_by = $1',
    parentId ? [parentId, user.id] : [user.id],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await query(
    'insert into folders (parent_id, name, icon, position, created_by) values ($1, $2, $3, $4, $5) returning *',
    [
      parentId ?? null,
      typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'New Folder',
      typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
      nextPosition,
      user.id,
    ],
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create folder' });
  }

  const created = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);
  return c.json(created, 201);
});

foldersRoute.get(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };
  await ensureFolderAccess(folder.id, user.id);

  return c.json(folder);
});

foldersRoute.patch(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };
  await ensureFolderAccess(folder.id, user.id, 'edit');

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { name, icon, parentId, position, isAccessRestricted } = body as {
    name?: string;
    icon?: string | null;
    parentId?: string | null;
    position?: string | number;
    isAccessRestricted?: boolean;
  };

  const hasRestricted = Object.hasOwn(body, 'isAccessRestricted');
  if (hasRestricted && isAccessRestricted !== folder.isAccessRestricted) {
    await ensureCanAdminEntity('folder', folder.id, user.id);
  }

  const hasParentId = Object.hasOwn(body, 'parentId');
  if (hasParentId) {
    if (parentId) {
      if (parentId === folder.id) {
        throw new HTTPException(400, { message: 'Cannot set parent to self' });
      }
      const parent = await getFolderById(parentId);
      if (!parent) {
        throw new HTTPException(404, { message: 'Parent folder not found' });
      }
      await ensureFolderAccess(parent.id, user.id, 'edit');
    } else if (folder.parentId !== null) {
      await ensureCanAdminEntity('folder', folder.id, user.id);
    }
  }

  const nextParent = hasParentId ? (parentId ?? null) : folder.parentId;
  await ensureNoFolderCycle(folder.id, nextParent, user.id);

  const nextName =
    typeof name === 'string' ? (name.trim().length > 0 ? name.trim() : 'New Folder') : folder.name;
  const nextIcon =
    typeof icon === 'string'
      ? icon.trim().length > 0
        ? icon.trim()
        : null
      : icon === null
        ? null
        : folder.icon;
  const nextPosition =
    typeof position === 'string'
      ? position.trim().length > 0
        ? position.trim()
        : folder.position
      : typeof position === 'number' && Number.isFinite(position)
        ? String(position)
        : folder.position;

  const nextRestricted = hasRestricted ? isAccessRestricted === true : folder.isAccessRestricted;

  const updateResult = await query(
    `update folders set name = $1, icon = $2, parent_id = $3, position = $4,
       is_access_restricted = $5, updated_at = now() where id = $6 returning *`,
    [nextName, nextIcon, nextParent, nextPosition, nextRestricted, folderId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to update folder' });
  }

  if (hasRestricted && nextRestricted !== folder.isAccessRestricted) {
    if (nextRestricted) {
      await notifyShareRevoke({ entityType: 'folder', entityId: folderId });
    } else {
      await notifyShareUpdate({ entityType: 'folder', entityId: folderId });
    }
  }

  const updated = normalizeFolderRow(updateResult.rows[0] as RawFolderRow);
  return c.json(updated);
});

foldersRoute.post(':id/copy', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };
  await ensureFolderAccess(folder.id, user.id, 'edit');

  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;

  if (parentId) {
    if (parentId === folder.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const parent = await getFolderById(parentId);
    if (!parent) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    if (parent.isDeleted) {
      throw new HTTPException(400, { message: 'Cannot move into a deleted folder' });
    }
    await ensureFolderAccess(parent.id, user.id, 'edit');
  }

  await ensureNoFolderCycle(folder.id, parentId, user.id);

  try {
    const newFolder = await db.transaction((tx) =>
      copyFolderRecursive(tx, folderId, parentId, user.id),
    );
    return c.json(newFolder, 201);
  } catch (err) {
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : 'Failed to copy folder',
    });
  }
});

async function copyFolderRecursive(
  executor: QueryExecutor,
  sourceFolderId: string,
  newParentId: string | null,
  userId: string,
): Promise<FolderRow> {
  const sourceResult = await executeQuery(executor, 'select * from folders where id = $1', [
    sourceFolderId,
  ]);
  const source = normalizeFolderRow(sourceResult.rows[0] as RawFolderRow);

  const positionResult = await executeQuery(
    executor,
    newParentId
      ? 'select max(position) as max_position from folders where parent_id = $1 and created_by = $2'
      : 'select max(position) as max_position from folders where parent_id is null and created_by = $1',
    newParentId ? [newParentId, userId] : [userId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  // Copies are created by the copier. The root folder owner does not
  // automatically own copied content — ownership follows the creator.
  const insertResult = await executeQuery(
    executor,
    `insert into folders (id, parent_id, name, icon, position, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)
     returning *`,
    [newParentId ?? null, `Copy of ${source.name}`, source.icon, nextPosition, userId],
  );
  const newFolder = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);

  const pagesResult = await executeQuery(
    executor,
    'select * from pages where parent_id = $1 and is_deleted = false',
    [sourceFolderId],
  );
  for (const pageRow of pagesResult.rows) {
    const pr = pageRow as {
      title: string;
      icon: string | null;
      cover_type: string | null;
      cover_value: string | null;
      position: string;
      ydoc: Buffer | null;
    };
    await executeQuery(
      executor,
      `insert into pages (id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by)
        values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newFolder.id,
        `Copy of ${pr.title}`,
        pr.icon,
        pr.cover_type,
        pr.cover_value,
        pr.position,
        pr.ydoc,
        userId,
      ],
    );
  }

  const subfoldersResult = await executeQuery(
    executor,
    'select id from folders where parent_id = $1 and is_deleted = false',
    [sourceFolderId],
  );
  for (const subfolderRow of subfoldersResult.rows) {
    await copyFolderRecursive(executor, (subfolderRow as { id: string }).id, newFolder.id, userId);
  }

  return newFolder;
}

foldersRoute.delete(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };
  await ensureCanAdminEntity('folder', folder.id, user.id);

  const descendantFolders = await query(
    'SELECT descendant_id AS id FROM folder_closure WHERE ancestor_id = $1 AND descendant_id != $1',
    [folderId],
  );
  const descendantPages = await query(
    'SELECT p.id FROM pages p WHERE p.parent_id IN (SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1) AND p.is_deleted = false',
    [folderId],
  );

  const hasChildren = (descendantFolders.rowCount ?? 0) > 0 || (descendantPages.rowCount ?? 0) > 0;

  if (hasChildren) {
    const force = c.req.query('force') === 'true';

    if (!force) {
      return c.json({
        requiresForce: true,
        childFolders: descendantFolders.rowCount ?? 0,
        childPages: descendantPages.rowCount ?? 0,
        message: 'Folder is not empty. Add ?force=true to delete contents as well.',
      });
    }

    const childFolderIds = (descendantFolders.rows as { id: string }[]).map((r) => r.id);
    for (const childFolderId of childFolderIds) {
      await query(
        'update folders set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
        [childFolderId],
      );
    }

    const childPageIds = (descendantPages.rows as { id: string }[]).map((r) => r.id);
    for (const childPageId of childPageIds) {
      await query(
        'update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
        [childPageId],
      );
      await query('select pg_notify($1, $2)', [
        'page_deleted',
        JSON.stringify({ pageId: childPageId }),
      ]);
    }
  }

  const updateResult = await query(
    'update folders set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
    [folderId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to delete folder' });
  }

  await query('select pg_notify($1, $2)', ['folder_deleted', JSON.stringify({ folderId })]);

  await notifyShareRevoke({ entityType: 'folder', entityId: folderId });

  return c.json({ deleted: true });
});

foldersRoute.post(':id/leave', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  const user = c.get('user') as { id: string };

  const rootOwnerResult = await query('SELECT get_root_folder_owner($1) as owner_id', [folderId]);
  const rootOwnerId = rootOwnerResult.rows[0]?.owner_id as string | undefined;
  if (rootOwnerId === user.id) {
    throw new HTTPException(400, { message: 'Cannot leave your own folder' });
  }

  const shareResult = await query(
    "delete from shares where entity_type = 'folder' and entity_id = $1 and recipient_user_id = $2 returning id, recipient_user_id",
    [folderId, user.id],
  );

  const shareRow = shareResult.rows[0] as { id: string; recipient_user_id: string } | undefined;
  if (shareRow?.recipient_user_id) {
    await notifyShareRevoke({
      entityType: 'folder',
      entityId: folderId,
      targetUserId: shareRow.recipient_user_id,
    });
  }

  return c.json({ ok: true });
});

foldersPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    const folderId = c.req.param('id');
    const folder = await getFolderById(folderId);

    if (!folder) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    const linkAccess = await getFolderLinkAccess(folderId);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const user = session.user as { id: string };
      if (!linkAccess) {
        await ensureFolderAccess(folder.id, user.id);
      }
    } else if (!linkAccess) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    // Return folder children when accessed via public link
    const [pagesResult, foldersResult] = await Promise.all([
      query(
        `SELECT id, title, icon, created_by, created_at, updated_at, parent_id
         FROM pages WHERE parent_id = $1 AND is_deleted = false
         ORDER BY position ASC`,
        [folderId],
      ),
      query(
        `SELECT id, parent_id, name, icon, created_by, created_at, updated_at, is_public
         FROM folders WHERE parent_id = $1 AND is_deleted = false
         ORDER BY position ASC`,
        [folderId],
      ),
    ]);

    return c.json({
      ...folder,
      isPublic: folder.isPublic || !!linkAccess,
      linkPermission: linkAccess?.permission ?? null,
      pages: pagesResult.rows,
      folders: (foldersResult.rows as RawFolderRow[]).map(normalizeFolderRow),
    });
  },
);

foldersPublicRoute.post(':id/access', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  const linkAccess = await getFolderLinkAccess(folderId);
  if (!linkAccess) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

export { foldersPublicRoute };
export default foldersRoute;
