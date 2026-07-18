import { deriveCapabilities } from '@markdawn/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import type { folders } from '../db';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { prepareCopiedYdoc } from '../utils/documentSize';
import { getEnumerableFolderIds, redactParentId } from '../utils/folderEnumeration';
import {
  ensureActorCanCreateInFolder,
  ensureActorFolderAccess,
  getRequestActor,
  persistGuestIdentity,
  type RequestActor,
} from '../utils/guestAccess';
import { createCopyPageTitle } from '../utils/pageTitle';
import { getNextPosition, normalizePosition } from '../utils/position';
import {
  ensureCanAdminEntity,
  ensureFolderAccess,
  ensureWorkspaceAdmin,
  lockEntityAccess,
  lockEntityAccessMutation,
  lockEntityAccessMutations,
  lockWorkspaceAccessMutation,
  type SharePermission,
} from '../utils/share-access';
import { notifyShareRecompute, notifyShareRevoke } from '../utils/share-notify';
import { getEntityMetaUserIds, mergeMetaUserIds } from '../utils/shareRecipients';
import { purgeFolderSubtrees } from '../utils/trashLifecycle';
import { processUploadDeletionQueue } from '../utils/uploadCleanup';

type FolderRow = typeof folders.$inferSelect;
type NormalizedFolderRow = FolderRow & { ownerId?: string | null };

type RawFolderRow = FolderRow & {
  parent_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  is_deleted?: boolean | null;
  deleted_at?: Date | null;
  public_permission?: 'view' | 'edit' | null;
  inheritance_policy?: 'inherit' | 'restricted' | null;
};

type PublicPermission = 'view' | 'edit';

const foldersRoute = new Hono();
const foldersPublicRoute = new Hono();

const deletedFolderOwnerSql = `coalesce(
  (
    select root.created_by
    from folder_closure fc
    join folders root on root.id = fc.ancestor_id
    where fc.descendant_id = f.id
      and root.parent_id is null
    order by fc.depth desc
    limit 1
  ),
  f.created_by
)`;

foldersRoute.use('*', requireAuth);

const normalizeFolderRow = (row: RawFolderRow): NormalizedFolderRow => ({
  ...row,
  parentId: row.parentId ?? row.parent_id ?? null,
  ownerId: row.ownerId ?? row.owner_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
  isDeleted: row.isDeleted ?? row.is_deleted ?? false,
  deletedAt: row.deletedAt ?? row.deleted_at ?? null,
  publicPermission: row.publicPermission ?? row.public_permission ?? null,
  inheritancePolicy: row.inheritancePolicy ?? row.inheritance_policy ?? 'inherit',
});

const toFolderDto = (folder: NormalizedFolderRow, parentId: string | null) => ({
  id: folder.id,
  parentId,
  name: folder.name,
  icon: folder.icon,
  position: folder.position,
  createdBy: folder.createdBy,
  ownerId: folder.ownerId ?? null,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
  publicPermission: folder.publicPermission,
  inheritancePolicy: folder.inheritancePolicy,
});

type PublicFolderPageDto = {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: Date | null;
  publicPermission: PublicPermission;
};

type PublicFolderChildDto = {
  id: string;
  name: string;
  icon: string | null;
  updatedAt: Date | null;
  publicPermission: PublicPermission;
};

const toPublicFolderDto = (
  folder: NormalizedFolderRow,
  publicPermission: PublicPermission,
  userPermission: SharePermission,
  pages: readonly PublicFolderPageDto[],
  childFolders: readonly PublicFolderChildDto[],
) => ({
  id: folder.id,
  name: folder.name,
  icon: folder.icon,
  updatedAt: folder.updatedAt,
  publicPermission,
  userPermission,
  capabilities: deriveCapabilities(userPermission),
  pages,
  folders: childFolders,
});

const getFolderPublicPermission = async (
  folderId: string,
  executor?: QueryExecutor,
): Promise<PublicPermission | null> => {
  const statement = 'select get_public_folder_permission($1) as permission';
  const result = executor
    ? await executeQuery<{ permission: PublicPermission | null }>(executor, statement, [folderId])
    : await query<{ permission: PublicPermission | null }>(statement, [folderId]);
  return result.rows[0]?.permission ?? null;
};

const hasAccountFolderAccess = async (
  folderId: string,
  userId: string,
  executor: QueryExecutor,
): Promise<boolean> => {
  const result = await executeQuery<{ has_access: boolean }>(
    executor,
    `with folder_info as (
       select get_root_folder_owner($1) as owner_id
       where exists (select 1 from folders where id = $1 and is_deleted = false)
     )
     select exists (
       select 1 from folder_info where owner_id = $2
       union all
       select 1 from shares share
       where share.entity_type = 'folder'
         and share.entity_id = $1
         and share.recipient_user_id = $2
       union all
       select 1
       from shares share
       join folders source_folder on source_folder.id = share.entity_id
       where share.entity_type = 'folder'
         and share.entity_id in (
           select ancestor_id
           from folder_closure
           where descendant_id = $1 and ancestor_id != $1
         )
         and share.recipient_user_id = $2
         and source_folder.is_deleted = false
         and not is_folder_inheritance_blocked(share.entity_id, $1)
       union all
       select 1
       from folder_info
       join workspace_members member on member.workspace_owner_id = folder_info.owner_id
       where member.member_id = $2
         and not is_folder_path_restricted($1)
     ) as has_access`,
    [folderId, userId],
  );
  return result.rows[0]?.has_access === true;
};

const recordFolderPublicVisit = async (
  executor: QueryExecutor,
  folderId: string,
  userId: string,
): Promise<boolean> => {
  const result = await executeQuery(
    executor,
    `insert into folder_public_access_visits (folder_id, user_id, first_seen_at, last_seen_at)
     values ($1, $2, now(), now())
     on conflict (folder_id, user_id)
     do update set last_seen_at = excluded.last_seen_at
     returning (xmax = 0) as inserted`,
    [folderId, userId],
  );
  return result.rows[0]?.inserted === true;
};

const getFolderById = async (folderId: string, executor?: QueryExecutor) => {
  const statement =
    'select f.*, get_root_folder_owner(f.id) as owner_id from folders f where f.id = $1 and f.is_deleted = false limit 1';
  const result = executor
    ? await executeQuery(executor, statement, [folderId])
    : await query(statement, [folderId]);
  const row = (result.rows[0] as RawFolderRow | undefined) ?? null;
  return row ? normalizeFolderRow(row) : null;
};

const getDeletedFolderById = async (folderId: string, executor?: QueryExecutor) => {
  const statement = `select f.*, ${deletedFolderOwnerSql} as owner_id
    from folders f where f.id = $1 and f.is_deleted = true limit 1`;
  const result = executor
    ? await executeQuery(executor, statement, [folderId])
    : await query(statement, [folderId]);
  const row = (result.rows[0] as RawFolderRow | undefined) ?? null;
  return row ? normalizeFolderRow(row) : null;
};

const ensureFolderOrganizationAccess = async (
  folder: NormalizedFolderRow,
  targetParentId: string | null,
  userId: string,
  executor?: QueryExecutor,
) => {
  if (!folder.ownerId) {
    throw new HTTPException(409, { message: 'Folder owner could not be determined' });
  }
  if (targetParentId === folder.id) {
    throw new HTTPException(400, { message: 'Cannot set parent to self' });
  }

  await ensureFolderAccess(folder.id, userId, 'admin', executor);
  if (folder.parentId) {
    await ensureFolderAccess(folder.parentId, userId, 'admin', executor);
  } else {
    await ensureWorkspaceAdmin(folder.ownerId, userId, executor);
  }

  let destinationOwnerId: string | null = folder.createdBy;
  if (targetParentId) {
    const destination = await getFolderById(targetParentId, executor);
    if (!destination?.ownerId) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    destinationOwnerId = destination.ownerId;
    await ensureFolderAccess(destination.id, userId, 'admin', executor);
  } else if (destinationOwnerId) {
    await ensureWorkspaceAdmin(destinationOwnerId, userId, executor);
  }

  if (destinationOwnerId !== folder.ownerId) {
    throw new HTTPException(409, { message: 'Folders cannot be moved between different owners' });
  }
};

const ensureNoFolderCycle = async (
  folderId: string,
  targetParentId: string | null,
  _userId: string,
  executor?: QueryExecutor,
) => {
  if (!targetParentId) {
    return;
  }

  // Check if targetParentId is already a descendant of folderId (would create a cycle)
  const statement = `SELECT 1 FROM folder_closure
     WHERE ancestor_id = $1 AND descendant_id = $2 AND depth > 0`;
  const result = executor
    ? await executeQuery(executor, statement, [folderId, targetParentId])
    : await query(statement, [folderId, targetParentId]);
  if (result.rowCount && result.rowCount > 0) {
    throw new HTTPException(400, { message: 'Cannot move folder into its own subtree' });
  }
};

const buildFolderTree = <T extends { id: string; parentId: string | null }>(rows: T[]) => {
  type FolderNode = T & { children: FolderNode[] };
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
      select f.*, get_root_folder_owner(f.id) as owner_id,
             case
               when f.parent_id in (select folder_id from get_enumerable_folder_ids($1))
                 then f.parent_id
               else null
             end as enumerable_parent_id,
             access.permission as user_permission,
             exists (
               select 1 from workspace_members wm
               where wm.workspace_owner_id = get_root_folder_owner(f.id)
                 and wm.member_id = $1
                 and not is_folder_path_restricted(f.id)
             ) as workspace_access
      from folders f
      join lateral get_effective_folder_permission(f.id, $1) access on true
      where f.is_deleted = false
        and f.id in (select folder_id from get_enumerable_folder_ids($1))
        and access.permission is not null
      order by f.parent_id nulls first, case when f.parent_id is null then f.updated_at end desc nulls last, f.position::numeric asc
    `,
    [user.id],
  );

  return c.json(
    buildFolderTree(
      (
        result.rows as (RawFolderRow & {
          enumerable_parent_id?: string | null;
          user_permission?: string | null;
          workspace_access?: boolean;
        })[]
      ).map((row) => {
        const folder = normalizeFolderRow(row);
        return {
          ...toFolderDto(folder, row.enumerable_parent_id ?? null),
          userPermission: row.user_permission ?? null,
          workspaceAccess: row.workspace_access === true,
        };
      }),
    ),
  );
});

foldersPublicRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, name, icon } = body as {
    parentId?: string | null;
    name?: string;
    icon?: string | null;
  };

  const actor = await getRequestActor(c);
  if (!parentId && actor.kind === 'guest') {
    throw new HTTPException(401, { message: 'Log in to create a root folder' });
  }

  const insertResult = await db.transaction(async (tx) => {
    if (parentId) {
      await lockEntityAccessMutation(tx, 'folder', parentId);
      await ensureActorCanCreateInFolder(actor, parentId, tx);
    } else {
      await lockWorkspaceAccessMutation(tx, actor.id);
    }
    await persistGuestIdentity(actor, tx);

    const nextPosition = await getNextPosition('folders', parentId ?? null, actor.id, tx);
    const result = await executeQuery(
      tx,
      'insert into folders (parent_id, name, icon, position, created_by) values ($1, $2, $3, $4, $5) returning *',
      [
        parentId ?? null,
        typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'New Folder',
        typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
        nextPosition,
        actor.kind === 'user' ? actor.id : null,
      ],
    );
    const createdFolderId = result.rows[0]?.id as string | undefined;
    if (createdFolderId) {
      const metaUserIds = await getEntityMetaUserIds(tx, 'folder', createdFolderId);
      await notifyShareRecompute(
        {
          entityType: 'folder',
          entityId: createdFolderId,
          metaUserIds,
          metaOnly: true,
        },
        tx,
      );
    }
    return result;
  });

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create folder' });
  }

  const created = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);
  return c.json(created, 201);
});

foldersRoute.get('/trash', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await query(
    `select f.*, ${deletedFolderOwnerSql} as owner_id
     from folders f
     left join folders parent on parent.id = f.parent_id
     where f.is_deleted = true
       and ${deletedFolderOwnerSql} = $1
       and coalesce(parent.is_deleted, false) = false
     order by f.deleted_at desc nulls last, f.position::numeric asc`,
    [user.id],
  );

  return c.json((result.rows as RawFolderRow[]).map(normalizeFolderRow));
});

foldersRoute.delete('/trash/empty-all', async (c) => {
  const user = c.get('user') as { id: string };
  const purged = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const roots = await executeQuery<{ id: string }>(
      tx,
      `select f.id
       from folders f
       left join folders parent on parent.id = f.parent_id
       where f.is_deleted = true
         and ${deletedFolderOwnerSql} = $1
         and coalesce(parent.is_deleted, false) = false
       order by f.id
       for update of f`,
      [user.id],
    );
    return purgeFolderSubtrees(
      tx,
      roots.rows.map((row) => row.id),
    );
  });
  await processUploadDeletionQueue();

  return c.json({ deleted: true, folders: purged.folders, pages: purged.pages });
});

foldersRoute.patch(':id/restore', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getDeletedFolderById(folderId);
  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  const user = c.get('user') as { id: string };
  if (folder.ownerId !== user.id) {
    throw new HTTPException(403, { message: 'You can only restore folders that you own' });
  }

  const restored = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const rootResult = await executeQuery<{
      parent_id: string | null;
      created_by: string | null;
      deleted_at: Date | null;
      deletion_batch_id: string | null;
      owner_id: string | null;
    }>(
      tx,
      `select f.parent_id, f.created_by, f.deleted_at, f.deletion_batch_id,
              ${deletedFolderOwnerSql} as owner_id
       from folders f
       where f.id = $1 and f.is_deleted = true
       for update`,
      [folderId],
    );
    const root = rootResult.rows[0];
    if (!root) throw new HTTPException(404, { message: 'Folder not found' });
    if (root.owner_id !== user.id) {
      throw new HTTPException(403, { message: 'You can only restore folders that you own' });
    }
    if (!root.deleted_at) {
      throw new HTTPException(409, { message: 'Folder deletion state is invalid' });
    }
    const affectedBefore = await getEntityMetaUserIds(tx, 'folder', folderId);

    const foldersResult = await executeQuery<{ id: string; depth: number }>(
      tx,
      `select f.id, fc.depth
       from folder_closure fc
       join folders f on f.id = fc.descendant_id
       where fc.ancestor_id = $1
         and f.is_deleted = true
         and (
           ($2::uuid is not null and f.deletion_batch_id = $2)
           or ($2::uuid is null and f.deletion_batch_id is null and f.deleted_at = $3)
         )
       order by fc.depth, f.id
       for update of f`,
      [folderId, root.deletion_batch_id, root.deleted_at],
    );
    const batchFolders = foldersResult.rows;
    const folderIds = batchFolders.map((row) => row.id);
    if (!folderIds.includes(folderId)) {
      throw new HTTPException(409, { message: 'Folder deletion state is invalid' });
    }

    const pagesResult = await executeQuery<{ id: string }>(
      tx,
      `select p.id
       from pages p
       where p.parent_id = any($1::uuid[])
         and p.is_deleted = true
         and (
           ($2::uuid is not null and p.deletion_batch_id = $2)
           or ($2::uuid is null and p.deletion_batch_id is null and p.deleted_at = $3)
         )
       order by p.id
       for update of p`,
      [folderIds, root.deletion_batch_id, root.deleted_at],
    );
    const pageIds = pagesResult.rows.map((row) => row.id);

    let restoreParentId: string | null = null;
    if (root.parent_id) {
      const parentResult = await executeQuery<{ id: string }>(
        tx,
        'select id from folders where id = $1 and is_deleted = false for share',
        [root.parent_id],
      );
      if ((parentResult.rowCount ?? 0) > 0) restoreParentId = root.parent_id;
    }
    const nextPosition = await getNextPosition('folders', restoreParentId, user.id, tx);
    await executeQuery(
      tx,
      `update folders
       set is_deleted = false, deleted_at = null, deletion_batch_id = null, parent_id = $1,
           created_by = $2, position = $3, updated_at = now()
       where id = $4 and is_deleted = true`,
      [restoreParentId, restoreParentId ? root.created_by : user.id, nextPosition, folderId],
    );

    for (const descendant of batchFolders) {
      if (descendant.id === folderId) continue;
      await executeQuery(
        tx,
        `update folders
         set is_deleted = false, deleted_at = null, deletion_batch_id = null, updated_at = now()
         where id = $1 and is_deleted = true`,
        [descendant.id],
      );
    }
    if (pageIds.length > 0) {
      await executeQuery(
        tx,
        `update pages
         set is_deleted = false, deleted_at = null, deletion_batch_id = null, updated_at = now()
         where id = any($1::uuid[]) and is_deleted = true`,
        [pageIds],
      );
    }

    const affectedAfter = await getEntityMetaUserIds(tx, 'folder', folderId);
    const metaUserIds = mergeMetaUserIds(affectedBefore, affectedAfter);
    await notifyShareRecompute({ entityType: 'folder', entityId: folderId, metaUserIds }, tx);
    const updated = await executeQuery(
      tx,
      'select f.*, get_root_folder_owner(f.id) as owner_id from folders f where f.id = $1',
      [folderId],
    );
    return {
      folder: normalizeFolderRow(updated.rows[0] as RawFolderRow),
      restoredFolders: folderIds.length,
      restoredPages: pageIds.length,
    };
  });

  return c.json({
    ...restored.folder,
    restoredFolders: restored.restoredFolders,
    restoredPages: restored.restoredPages,
  });
});

foldersRoute.delete(':id/permanent', async (c) => {
  const folderId = c.req.param('id');
  const user = c.get('user') as { id: string };
  const folder = await getDeletedFolderById(folderId);
  if (!folder) {
    const activeFolder = await getFolderById(folderId);
    if (activeFolder) {
      if (activeFolder.ownerId !== user.id) {
        throw new HTTPException(403, {
          message: 'You can only permanently delete folders that you own',
        });
      }
      throw new HTTPException(409, {
        message: 'Folder must be moved to Trash before it can be permanently deleted',
      });
    }
    throw new HTTPException(404, { message: 'Folder not found' });
  }

  if (folder.ownerId !== user.id) {
    throw new HTTPException(403, {
      message: 'You can only permanently delete folders that you own',
    });
  }

  const purged = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const lockedFolder = await executeQuery<{ owner_id: string | null }>(
      tx,
      `select ${deletedFolderOwnerSql} as owner_id
       from folders f
       where f.id = $1 and f.is_deleted = true
       for update`,
      [folderId],
    );
    const ownerId = lockedFolder.rows[0]?.owner_id;
    if (!ownerId) throw new HTTPException(404, { message: 'Folder not found' });
    if (ownerId !== user.id) {
      throw new HTTPException(403, {
        message: 'You can only permanently delete folders that you own',
      });
    }
    return purgeFolderSubtrees(tx, [folderId]);
  });
  await processUploadDeletionQueue();

  return c.json({ deleted: true, folders: purged.folders, pages: purged.pages });
});

foldersRoute.get(':id', async (c) => {
  const folderId = c.req.param('id');
  const user = c.get('user') as { id: string };
  const folder = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'folder', folderId);
    const currentFolder = await getFolderById(folderId, tx);
    if (!currentFolder) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }
    await ensureFolderAccess(currentFolder.id, user.id, 'view', tx);
    const enumerableFolderIds = await getEnumerableFolderIds(user.id, tx);
    return toFolderDto(currentFolder, redactParentId(currentFolder.parentId, enumerableFolderIds));
  });

  return c.json(folder);
});

foldersRoute.patch(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { name, icon, parentId, position } = body as {
    name?: string;
    icon?: string | null;
    parentId?: string | null;
    position?: string | number;
  };

  const hasParentId = Object.hasOwn(body, 'parentId');
  const hasPosition = Object.hasOwn(body, 'position');

  const updateResult = await db.transaction(async (tx) => {
    const workspaceOwnerId = await lockEntityAccess(tx, 'folder', folderId);
    const currentFolder = await getFolderById(folderId, tx);
    if (!currentFolder) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    const nextParent = hasParentId ? (parentId ?? null) : currentFolder.parentId;
    if (hasParentId || hasPosition) {
      await ensureFolderOrganizationAccess(currentFolder, nextParent, user.id, tx);
    } else {
      await ensureFolderAccess(currentFolder.id, user.id, 'admin', tx);
    }
    await ensureNoFolderCycle(currentFolder.id, nextParent, user.id, tx);

    const nextName =
      typeof name === 'string'
        ? name.trim().length > 0
          ? name.trim()
          : 'New Folder'
        : currentFolder.name;
    const nextIcon =
      typeof icon === 'string'
        ? icon.trim().length > 0
          ? icon.trim()
          : null
        : icon === null
          ? null
          : currentFolder.icon;
    const nextPosition = normalizePosition(position, currentFolder.position);
    const accessChanged = hasParentId && nextParent !== currentFolder.parentId;
    if (accessChanged) {
      await lockWorkspaceAccessMutation(tx, workspaceOwnerId);
    }
    const affectedBefore = accessChanged ? await getEntityMetaUserIds(tx, 'folder', folderId) : [];
    const result = await executeQuery(
      tx,
      `update folders set name = $1, icon = $2, parent_id = $3, position = $4, updated_at = now() where id = $5 returning *`,
      [nextName, nextIcon, nextParent, nextPosition, folderId],
    );

    if (result.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to update folder' });
    }

    if (accessChanged) {
      const affectedAfter = await getEntityMetaUserIds(tx, 'folder', folderId);
      await notifyShareRecompute(
        {
          entityType: 'folder',
          entityId: folderId,
          metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
        },
        tx,
      );
    }
    return {
      result,
      enumerableFolderIds: await getEnumerableFolderIds(user.id, tx),
    };
  });

  const updated = normalizeFolderRow(updateResult.result.rows[0] as RawFolderRow);
  return c.json(
    toFolderDto(updated, redactParentId(updated.parentId, updateResult.enumerableFolderIds)),
  );
});

foldersPublicRoute.post(':id/copy', async (c) => {
  const folderId = c.req.param('id');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;
  if (!parentId && actor.kind === 'guest') {
    throw new HTTPException(401, { message: 'Log in to copy a folder to the workspace root' });
  }
  if (parentId === folderId) {
    throw new HTTPException(400, { message: 'Cannot set parent to self' });
  }

  const copyState = { skippedRestrictedItems: false };
  const newFolder = await db.transaction(async (tx) => {
    await lockEntityAccessMutations(
      tx,
      [
        { entityType: 'folder', entityId: folderId },
        ...(parentId ? [{ entityType: 'folder' as const, entityId: parentId }] : []),
      ],
      parentId ? [] : [actor.id],
    );
    const currentFolder = await getFolderById(folderId, tx);
    if (!currentFolder) throw new HTTPException(404, { message: 'Folder not found' });
    await ensureActorFolderAccess(actor, folderId, 'view', tx);
    if (parentId) await ensureActorCanCreateInFolder(actor, parentId, tx);
    await ensureNoFolderCycle(folderId, parentId, actor.id, tx);
    await persistGuestIdentity(actor, tx);
    const copiedRoot = await copyFolderRecursive(tx, folderId, parentId, actor, copyState);
    if (copiedRoot) {
      const metaUserIds = await getEntityMetaUserIds(tx, 'folder', copiedRoot.id);
      await notifyShareRecompute(
        {
          entityType: 'folder',
          entityId: copiedRoot.id,
          metaUserIds,
          metaOnly: true,
        },
        tx,
      );
    }
    return copiedRoot;
  });
  if (!newFolder) {
    throw new HTTPException(409, {
      message: 'Source folder is no longer accessible',
      cause: { code: 'SOURCE_FOLDER_UNAVAILABLE' },
    });
  }
  return c.json({ ...newFolder, skippedRestrictedItems: copyState.skippedRestrictedItems }, 201);
});

async function copyFolderRecursive(
  executor: QueryExecutor,
  sourceFolderId: string,
  newParentId: string | null,
  actor: RequestActor,
  state: { skippedRestrictedItems: boolean },
): Promise<FolderRow | null> {
  const sourceResult =
    actor.kind === 'user'
      ? await executeQuery(
          executor,
          `select f.*
           from folders f
           join lateral get_effective_folder_permission(f.id, $2) access on true
           where f.id = $1 and f.is_deleted = false and access.permission is not null`,
          [sourceFolderId, actor.id],
        )
      : await executeQuery(
          executor,
          `select f.*
           from folders f
           where f.id = $1 and f.is_deleted = false
             and get_public_folder_permission(f.id) is not null`,
          [sourceFolderId],
        );
  const sourceRow = sourceResult.rows[0] as RawFolderRow | undefined;
  if (!sourceRow) {
    state.skippedRestrictedItems = true;
    return null;
  }
  const source = normalizeFolderRow(sourceRow);

  const nextPosition = await getNextPosition('folders', newParentId, actor.id, executor);

  const insertResult = await executeQuery(
    executor,
    `insert into folders (id, parent_id, name, icon, position, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)
     returning *`,
    [
      newParentId,
      `Copy of ${source.name}`,
      source.icon,
      nextPosition,
      actor.kind === 'user' ? actor.id : null,
    ],
  );
  const newFolder = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);

  const pagesResult =
    actor.kind === 'user'
      ? await executeQuery(
          executor,
          `select p.*, access.permission as effective_permission
           from pages p
           left join lateral get_effective_page_permission(p.id, $2) access on true
           where p.parent_id = $1 and p.is_deleted = false
           order by p.position::numeric asc`,
          [sourceFolderId, actor.id],
        )
      : await executeQuery(
          executor,
          `select p.*, get_public_page_permission(p.id) as effective_permission
           from pages p
           where p.parent_id = $1 and p.is_deleted = false
           order by p.position::numeric asc`,
          [sourceFolderId],
        );
  for (const pageRow of pagesResult.rows) {
    const pr = pageRow as {
      id: string;
      title: string;
      icon: string | null;
      cover_type: string | null;
      cover_value: string | null;
      position: string;
      ydoc: Buffer | null;
      properties: unknown;
      effective_permission: string | null;
    };
    if (!pr.effective_permission) {
      state.skippedRestrictedItems = true;
      continue;
    }

    const copiedTitle = createCopyPageTitle(pr.title);
    const copiedYdoc = prepareCopiedYdoc(pr.ydoc, copiedTitle);

    const copiedPage = await executeQuery(
      executor,
      `insert into pages (
         id, parent_id, title, title_search, icon, cover_type, cover_value,
         position, ydoc, properties, created_by
       ) values (
         gen_random_uuid(), $1, $2, to_tsvector('english', $2), $3, $4, $5,
         $6, $7, $8, $9
       ) returning id`,
      [
        newFolder.id,
        copiedTitle,
        pr.icon,
        pr.cover_type,
        pr.cover_value,
        pr.position,
        copiedYdoc,
        pr.properties,
        actor.kind === 'user' ? actor.id : null,
      ],
    );
    const copiedPageId = copiedPage.rows[0]?.id as string | undefined;
    if (copiedPageId) {
      await executeQuery(
        executor,
        `insert into upload_page_refs (upload_id, page_id)
         select upload_id, $1 from upload_page_refs where page_id = $2
         on conflict (upload_id, page_id) do nothing`,
        [copiedPageId, pr.id],
      );
      await executeQuery(
        executor,
        `insert into connections (
           source_type, source_id, target_type, target_id, target_slug,
           target_label, connection_type, link_text, link_context,
           occurrence_count, first_seen_at, updated_at
         )
         select source_type, $1, target_type, target_id, target_slug,
                target_label, connection_type, link_text, link_context,
                occurrence_count, first_seen_at, now()
         from connections
         where source_type = 'page' and source_id = $2`,
        [copiedPageId, pr.id],
      );
      await executeQuery(
        executor,
        `insert into connection_occurrences (
           connection_id, source_block_id, position, context, created_at
         )
         select copied.id, occurrence.source_block_id, occurrence.position,
                occurrence.context, occurrence.created_at
         from connections original
         join connections copied
           on copied.source_type = original.source_type
          and copied.source_id = $1
          and copied.target_type = original.target_type
          and copied.target_slug = original.target_slug
          and copied.connection_type = original.connection_type
         join connection_occurrences occurrence on occurrence.connection_id = original.id
         where original.source_type = 'page' and original.source_id = $2`,
        [copiedPageId, pr.id],
      );
    }
  }

  const subfoldersResult =
    actor.kind === 'user'
      ? await executeQuery(
          executor,
          `select f.id, access.permission as effective_permission
           from folders f
           left join lateral get_effective_folder_permission(f.id, $2) access on true
           where f.parent_id = $1 and f.is_deleted = false
           order by f.position::numeric asc`,
          [sourceFolderId, actor.id],
        )
      : await executeQuery(
          executor,
          `select f.id, get_public_folder_permission(f.id) as effective_permission
           from folders f
           where f.parent_id = $1 and f.is_deleted = false
           order by f.position::numeric asc`,
          [sourceFolderId],
        );
  for (const subfolderRow of subfoldersResult.rows as {
    id: string;
    effective_permission: string | null;
  }[]) {
    if (!subfolderRow.effective_permission) {
      state.skippedRestrictedItems = true;
      continue;
    }
    await copyFolderRecursive(executor, subfolderRow.id, newFolder.id, actor, state);
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

  const force = c.req.query('force') === 'true';
  const deletionResult = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'folder', folderId);
    const lockedRoot = await executeQuery(
      tx,
      'select id from folders where id = $1 and is_deleted = false for update',
      [folderId],
    );
    if ((lockedRoot.rowCount ?? 0) === 0) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    const rootAccess = await executeQuery<{ permission: string; full_access: boolean }>(
      tx,
      'select permission, full_access from get_effective_folder_permission($1, $2)',
      [folderId, user.id],
    );
    const rootPermission = rootAccess.rows[0];
    if (!rootPermission?.full_access && rootPermission?.permission !== 'admin') {
      throw new HTTPException(403, { message: 'You need admin access to access this folder' });
    }
    const metaUserIds = await getEntityMetaUserIds(tx, 'folder', folderId);

    // Lock the subtree itself instead of taking a table-wide lock. Inserts,
    // restores, and moves take a shared lock on their old/new parent through
    // ensure_active_folder_parent(), so repeat discovery until every active
    // descendant visible after waiting has been locked.
    const lockedFolderIds = new Set<string>([folderId]);
    while (true) {
      const subtree = await executeQuery<{ id: string }>(
        tx,
        `select f.id
         from folder_closure fc
         join folders f on f.id = fc.descendant_id and f.is_deleted = false
         where fc.ancestor_id = $1
         order by f.id
         for update of f`,
        [folderId],
      );
      const previousSize = lockedFolderIds.size;
      for (const row of subtree.rows) lockedFolderIds.add(row.id);
      if (lockedFolderIds.size === previousSize) break;
    }

    const childFolderIds = Array.from(lockedFolderIds).filter((id) => id !== folderId);
    const descendantPages = await executeQuery<{ id: string }>(
      tx,
      `select p.id
       from pages p
       where p.parent_id = any($1::uuid[])
         and p.is_deleted = false
       order by p.id
       for update of p`,
      [Array.from(lockedFolderIds)],
    );
    const childPageIds = descendantPages.rows.map((row) => row.id);

    const inaccessibleDescendants = await executeQuery(
      tx,
      `select 1
       from folders f
       join lateral get_effective_folder_permission(f.id, $2) access on true
       where f.id = any($1::uuid[])
         and not coalesce(access.full_access or access.permission = 'admin', false)
       union all
       select 1
       from pages p
       join lateral get_effective_page_permission(p.id, $2) access on true
       where p.id = any($3::uuid[])
         and not coalesce(access.full_access or access.permission = 'admin', false)
       limit 1`,
      [childFolderIds, user.id, childPageIds],
    );
    if ((inaccessibleDescendants.rowCount ?? 0) > 0) {
      throw new HTTPException(403, {
        message: 'This folder contains restricted items you do not have admin access to',
      });
    }

    const childFolders = childFolderIds.length;
    const childPages = childPageIds.length;
    if ((childFolders > 0 || childPages > 0) && !force) {
      return { requiresForce: true as const, childFolders, childPages };
    }
    const deletionBatchId = crypto.randomUUID();
    if (childFolderIds.length > 0) {
      await executeQuery(
        tx,
        `update folders
         set is_deleted = true, deleted_at = now(), deletion_batch_id = $2, updated_at = now()
         where id = any($1::uuid[])`,
        [childFolderIds, deletionBatchId],
      );
    }
    if (childPageIds.length > 0) {
      await executeQuery(
        tx,
        `update pages
         set is_deleted = true, deleted_at = now(), deletion_batch_id = $2, updated_at = now()
         where id = any($1::uuid[])`,
        [childPageIds, deletionBatchId],
      );
    }

    const updateResult = await executeQuery(
      tx,
      `update folders
       set is_deleted = true, deleted_at = now(), deletion_batch_id = $2, updated_at = now()
       where id = $1 and is_deleted = false
       returning id`,
      [folderId, deletionBatchId],
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      throw new HTTPException(409, { message: 'Folder was deleted concurrently' });
    }

    await executeQuery(tx, 'select pg_notify($1, $2)', [
      'folder_deleted',
      JSON.stringify({ folderId }),
    ]);
    await notifyShareRevoke({ entityType: 'folder', entityId: folderId, metaUserIds }, tx);
    return { deleted: true as const };
  });

  if ('requiresForce' in deletionResult) {
    return c.json(
      {
        code: 'FOLDER_NOT_EMPTY',
        ...deletionResult,
        message: 'Folder is not empty. Confirm recursive deletion to continue.',
      },
      409,
    );
  }

  return c.json(deletionResult);
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

  await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'folder', folderId);
    const shareResult = await executeQuery(
      tx,
      "delete from shares where entity_type = 'folder' and entity_id = $1 and recipient_user_id = $2 returning id, recipient_user_id",
      [folderId, user.id],
    );
    const eventResult = await executeQuery(
      tx,
      'delete from folder_public_access_visits where folder_id = $1 and user_id = $2 returning id',
      [folderId, user.id],
    );

    const shareRow = shareResult.rows[0] as { id: string; recipient_user_id: string } | undefined;
    if (!shareRow && (eventResult.rowCount ?? 0) === 0) {
      throw new HTTPException(409, {
        message: 'This folder is inherited from a parent or workspace and cannot be left directly',
      });
    }

    await notifyShareRevoke(
      {
        entityType: 'folder',
        entityId: folderId,
        targetUserId: shareRow?.recipient_user_id ?? user.id,
        ...(rootOwnerId ? { metaUserIds: [rootOwnerId] } : {}),
      },
      tx,
    );
  });

  return c.json({ ok: true });
});

foldersPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    const folderId = c.req.param('id');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
    const result = await db.transaction(async (tx) => {
      await lockEntityAccess(tx, 'folder', folderId);
      const lockedFolder = await getFolderById(folderId, tx);
      if (!lockedFolder) {
        throw new HTTPException(404, { message: 'Folder not found' });
      }

      const publicPermission = await getFolderPublicPermission(folderId, tx);
      const hasAccountAccess = sessionUserId
        ? await hasAccountFolderAccess(folderId, sessionUserId, tx)
        : false;
      let userPermission: SharePermission;
      let fullAccess = false;
      if (sessionUserId) {
        const access = await ensureFolderAccess(folderId, sessionUserId, 'view', tx);
        userPermission = access.permission;
        fullAccess = access.fullAccess;
      } else {
        if (!publicPermission) {
          throw new HTTPException(401, { message: 'Log in to access this folder' });
        }
        userPermission = publicPermission;
      }

      if (sessionUserId && publicPermission && lockedFolder.ownerId !== sessionUserId) {
        const inserted = await recordFolderPublicVisit(tx, folderId, sessionUserId);
        if (inserted) {
          await notifyShareRecompute(
            {
              entityType: 'folder',
              entityId: folderId,
              targetUserId: sessionUserId,
              metaUserIds: [sessionUserId],
              metaOnly: true,
            },
            tx,
          );
        }
      }

      const pagesResult = await executeQuery(
        tx,
        `SELECT id, title, icon, created_by, created_at, updated_at, parent_id,
                get_public_page_permission(p.id) as public_permission,
                coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
                access.permission as user_permission
         FROM pages p
         JOIN LATERAL get_effective_page_permission(p.id, $2::uuid) access ON true
         WHERE parent_id = $1 AND is_deleted = false
           AND access.permission IS NOT NULL
         ORDER BY position::numeric ASC`,
        [folderId, sessionUserId],
      );
      const foldersResult = await executeQuery(
        tx,
        `SELECT id, parent_id, name, icon, created_by, created_at, updated_at,
                get_public_folder_permission(f.id) as public_permission,
                get_root_folder_owner(f.id) as owner_id,
                access.permission as user_permission
         FROM folders f
         JOIN LATERAL get_effective_folder_permission(f.id, $2::uuid) access ON true
         WHERE parent_id = $1 AND is_deleted = false
           AND access.permission IS NOT NULL
         ORDER BY position::numeric ASC`,
        [folderId, sessionUserId],
      );

      const enumerableFolderIds =
        sessionUserId && hasAccountAccess
          ? await getEnumerableFolderIds(sessionUserId, tx)
          : new Set<string>();

      const pages = pagesResult.rows.map((row) => {
        const page = row as {
          id: string;
          parent_id: string | null;
          title: string;
          icon: string | null;
          created_by: string | null;
          owner_id: string | null;
          created_at: Date | null;
          updated_at: Date | null;
          public_permission: PublicPermission | null;
          user_permission: SharePermission;
        };
        return {
          id: page.id,
          parentId: page.parent_id,
          title: page.title,
          icon: page.icon,
          createdBy: page.created_by,
          ownerId: page.owner_id,
          createdAt: page.created_at,
          updatedAt: page.updated_at,
          publicPermission: page.public_permission,
          userPermission: page.user_permission,
        };
      });
      const childFolders = foldersResult.rows.map((row) => {
        const folder = row as {
          id: string;
          parent_id: string | null;
          name: string;
          icon: string | null;
          created_by: string | null;
          owner_id: string | null;
          created_at: Date | null;
          updated_at: Date | null;
          public_permission: PublicPermission | null;
          user_permission: SharePermission;
        };
        return {
          id: folder.id,
          parentId: folder.parent_id,
          name: folder.name,
          icon: folder.icon,
          createdBy: folder.created_by,
          ownerId: folder.owner_id,
          createdAt: folder.created_at,
          updatedAt: folder.updated_at,
          publicPermission: folder.public_permission,
          userPermission: folder.user_permission,
        };
      });

      if (!hasAccountAccess) {
        if (!publicPermission) {
          throw new HTTPException(403, { message: 'You do not have public access to this folder' });
        }
        const publicPages = pages.flatMap((page) =>
          page.publicPermission
            ? [
                {
                  id: page.id,
                  title: page.title,
                  icon: page.icon,
                  updatedAt: page.updatedAt,
                  publicPermission: page.publicPermission,
                } satisfies PublicFolderPageDto,
              ]
            : [],
        );
        const publicChildFolders = childFolders.flatMap((folder) =>
          folder.publicPermission
            ? [
                {
                  id: folder.id,
                  name: folder.name,
                  icon: folder.icon,
                  updatedAt: folder.updatedAt,
                  publicPermission: folder.publicPermission,
                } satisfies PublicFolderChildDto,
              ]
            : [],
        );
        return toPublicFolderDto(
          lockedFolder,
          publicPermission,
          userPermission,
          publicPages,
          publicChildFolders,
        );
      }

      return {
        ...toFolderDto(lockedFolder, redactParentId(lockedFolder.parentId, enumerableFolderIds)),
        publicPermission,
        userPermission,
        capabilities: deriveCapabilities(userPermission, fullAccess),
        pages,
        folders: childFolders,
      };
    });

    return c.json(result);
  },
);

foldersPublicRoute.post(':id/access', async (c) => {
  const folderId = c.req.param('id');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
  await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'folder', folderId);
    const folder = await getFolderById(folderId, tx);
    if (!folder) throw new HTTPException(404, { message: 'Folder not found' });
    const publicPermission = await getFolderPublicPermission(folderId, tx);
    if (sessionUserId) {
      await ensureFolderAccess(folderId, sessionUserId, 'view', tx);
      if (publicPermission && folder.ownerId !== sessionUserId) {
        await recordFolderPublicVisit(tx, folderId, sessionUserId);
      }
    } else if (!publicPermission) {
      throw new HTTPException(401, { message: 'Log in to access this folder' });
    }
  });

  return c.json({ ok: true });
});

export { foldersPublicRoute };
export default foldersRoute;
