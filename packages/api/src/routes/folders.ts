import {
  type AccountFolderPayload,
  deriveCapabilities,
  type PublicFolderPayload,
} from '@markdawn/shared';
import { sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { getDestinationOwnerId } from '../utils/destinationOwner';
import { moveFolderToTrash, removeFolderFromView } from '../utils/entityRemoval';
import { copyFolderRecursive } from '../utils/folderCopy';
import { getEnumerableFolderIds, redactParentId } from '../utils/folderEnumeration';
import { normalizeFolderName } from '../utils/folderName';
import {
  type FolderDatabaseRow,
  type FolderDatabaseRowWithOwner,
  type NormalizedFolderRow,
  normalizeFolderRow,
} from '../utils/folderRows';
import {
  ensureActorCanCreateInFolder,
  ensureActorFolderAccess,
  getRequestActor,
  persistGuestIdentity,
} from '../utils/guestAccess';
import { getNextPosition, normalizePosition } from '../utils/position';
import {
  getPublicPermission,
  type PublicPermission,
  recordPublicVisitAndNotify,
  resolveEntityAccess,
} from '../utils/publicAccess';
import {
  ensureFolderAccess,
  ensureWorkspaceAdmin,
  lockEntityAccess,
  lockEntityAccessMutation,
  lockEntityAccessMutations,
  lockWorkspaceAccessMutation,
  type SharePermission,
} from '../utils/share-access';
import { notifyShareRecompute } from '../utils/share-notify';
import { getEntityMetaUserIds, mergeMetaUserIds } from '../utils/shareRecipients';
import { purgeFolderSubtrees } from '../utils/trashLifecycle';
import { assertEntityWorkspaceAccess } from '../utils/org-auth';
import { processUploadDeletionQueue } from '../utils/uploadCleanup';

const foldersRoute = new Hono();
const foldersPublicRoute = new Hono();
const bodyLimitError = (c: Context) => c.json({ message: 'Request body is too large' }, 413);

const deletedFolderOwnerSql = sql`coalesce(
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
foldersRoute.use('*', bodyLimit({ maxSize: 16 * 1024, onError: bodyLimitError }));
const publicFolderBodyLimit = bodyLimit({ maxSize: 4 * 1024, onError: bodyLimitError });

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

/** Raw SQL result timestamps may be strings while Drizzle rows are Dates. */
export function serializeTimestamp(value: Date | string): string;
export function serializeTimestamp(value: null | undefined): null;
export function serializeTimestamp(value: Date | string | null | undefined): string | null;
export function serializeTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

const toPublicFolderDto = (
  folder: NormalizedFolderRow,
  publicPermission: PublicPermission,
  userPermission: PublicPermission,
  pages: PublicFolderPayload['pages'],
  childFolders: PublicFolderPayload['folders'],
): PublicFolderPayload => ({
  accessScope: 'public',
  id: folder.id,
  name: folder.name,
  icon: folder.icon,
  updatedAt: serializeTimestamp(folder.updatedAt),
  publicPermission,
  userPermission,
  capabilities: deriveCapabilities(userPermission),
  pages,
  folders: childFolders,
});

const getFolderById = async (folderId: string, executor?: QueryExecutor) => {
  const statement = sql`select f.*, get_root_folder_owner(f.id) as owner_id from folders f where f.id = ${folderId} and f.is_deleted = false limit 1`;
  const result = executor
    ? await executeQuery<FolderDatabaseRowWithOwner>(executor, statement)
    : await query<FolderDatabaseRowWithOwner>(statement);
  const row = result.rows[0] ?? null;
  return row ? normalizeFolderRow(row, row.owner_id) : null;
};

const getDeletedFolderById = async (folderId: string, executor?: QueryExecutor) => {
  const statement = sql`select f.*, ${deletedFolderOwnerSql} as owner_id
    from folders f where f.id = ${folderId} and f.is_deleted = true limit 1`;
  const result = executor
    ? await executeQuery<FolderDatabaseRowWithOwner>(executor, statement)
    : await query<FolderDatabaseRowWithOwner>(statement);
  const row = result.rows[0] ?? null;
  return row ? normalizeFolderRow(row, row.owner_id) : null;
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
  const statement = sql`SELECT 1 FROM folder_closure
     WHERE ancestor_id = ${folderId} AND descendant_id = ${targetParentId} AND depth > 0`;
  const result = executor ? await executeQuery(executor, statement) : await query(statement);
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

  type FolderTreeDatabaseRow = FolderDatabaseRowWithOwner & {
    enumerable_parent_id: string | null;
    user_permission: string | null;
    workspace_access: boolean;
  };
  const result = await query<FolderTreeDatabaseRow>(
    sql`
      select f.*, get_root_folder_owner(f.id) as owner_id,
             case
               when f.parent_id in (select folder_id from get_enumerable_folder_ids(${user.id}))
                 then f.parent_id
               else null
             end as enumerable_parent_id,
             access.permission as user_permission,
             exists (
               select 1 from workspace_members wm
               where wm.workspace_owner_id = get_root_folder_owner(f.id)
                 and wm.member_id = ${user.id}
                 and not is_folder_path_restricted(f.id)
             ) as workspace_access
      from folders f
      join lateral get_effective_folder_permission(f.id, ${user.id}) access on true
      where f.is_deleted = false
        and f.id in (select folder_id from get_enumerable_folder_ids(${user.id}))
        and access.permission is not null
      order by f.parent_id nulls first, case when f.parent_id is null then f.updated_at end desc nulls last, f.position::numeric asc
    `,
  );

  return c.json(
    buildFolderTree(
      result.rows.map((row) => {
        const folder = normalizeFolderRow(row, row.owner_id);
        return {
          ...toFolderDto(folder, row.enumerable_parent_id ?? null),
          userPermission: row.user_permission ?? null,
          workspaceAccess: row.workspace_access === true,
        };
      }),
    ),
  );
});

foldersPublicRoute.post('/', publicFolderBodyLimit, async (c) => {
  const body = await c.req.json().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'BodyLimitError') throw error;
    return null;
  });
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

    const ownerId = await getDestinationOwnerId(
      tx,
      parentId ?? null,
      actor.kind === 'user' ? actor.id : null,
    );
    if (!ownerId) throw new HTTPException(404, { message: 'Parent folder not found' });

    const nextPosition = await getNextPosition('folders', parentId ?? null, actor.id, tx);
    const result = await executeQuery<FolderDatabaseRow>(
      tx,
      sql`insert into folders (parent_id, name, icon, position, created_by) values (${parentId ?? null}, ${normalizeFolderName(typeof name === 'string' ? name : undefined)}, ${typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null}, ${nextPosition}, ${actor.kind === 'user' ? actor.id : null}) returning *`,
    );
    const createdFolderId = result.rows[0]?.id;
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
    return { result, ownerId };
  });

  if (insertResult.result.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create folder' });
  }

  const createdRow = insertResult.result.rows[0];
  if (!createdRow) throw new HTTPException(500, { message: 'Failed to create folder' });
  const created = normalizeFolderRow(createdRow, insertResult.ownerId);
  return c.json(created, 201);
});

foldersRoute.get('/trash', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await query<FolderDatabaseRowWithOwner>(
    sql`select f.*, ${deletedFolderOwnerSql} as owner_id
     from folders f
     left join folders parent on parent.id = f.parent_id
     where f.is_deleted = true
       and ${deletedFolderOwnerSql} = ${user.id}
       and coalesce(parent.is_deleted, false) = false
     order by f.deleted_at desc nulls last, f.position::numeric asc`,
  );

  return c.json(result.rows.map((row) => normalizeFolderRow(row, row.owner_id)));
});

foldersRoute.delete('/trash/empty-all', async (c) => {
  const user = c.get('user') as { id: string };
  const purged = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const roots = await executeQuery<{ id: string }>(
      tx,
      sql`select f.id
       from folders f
       left join folders parent on parent.id = f.parent_id
       where f.is_deleted = true
         and ${deletedFolderOwnerSql} = ${user.id}
         and coalesce(parent.is_deleted, false) = false
       order by f.id
       for update of f`,
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
  await assertEntityWorkspaceAccess(folder.workspaceId, user.id);
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
      sql`select f.parent_id, f.created_by, f.deleted_at, f.deletion_batch_id,
              ${deletedFolderOwnerSql} as owner_id
       from folders f
       where f.id = ${folderId} and f.is_deleted = true
       for update`,
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
      sql`select f.id, fc.depth
       from folder_closure fc
       join folders f on f.id = fc.descendant_id
       where fc.ancestor_id = ${folderId}
         and f.is_deleted = true
         and (
           (${root.deletion_batch_id}::uuid is not null and f.deletion_batch_id = ${root.deletion_batch_id})
           or (${root.deletion_batch_id}::uuid is null and f.deletion_batch_id is null and f.deleted_at = ${root.deleted_at})
         )
       order by fc.depth, f.id
       for update of f`,
    );
    const batchFolders = foldersResult.rows;
    const folderIds = batchFolders.map((row) => row.id);
    if (!folderIds.includes(folderId)) {
      throw new HTTPException(409, { message: 'Folder deletion state is invalid' });
    }

    const pagesResult = await executeQuery<{ id: string }>(
      tx,
      sql`select p.id
       from pages p
       where p.parent_id = any(${sql.param(folderIds)}::uuid[])
         and p.is_deleted = true
         and (
           (${root.deletion_batch_id}::uuid is not null and p.deletion_batch_id = ${root.deletion_batch_id})
           or (${root.deletion_batch_id}::uuid is null and p.deletion_batch_id is null and p.deleted_at = ${root.deleted_at})
         )
       order by p.id
       for update of p`,
    );
    const pageIds = pagesResult.rows.map((row) => row.id);

    let restoreParentId: string | null = null;
    if (root.parent_id) {
      const parentResult = await executeQuery<{ id: string }>(
        tx,
        sql`select id from folders where id = ${root.parent_id} and is_deleted = false for share`,
      );
      if ((parentResult.rowCount ?? 0) > 0) restoreParentId = root.parent_id;
    }
    const nextPosition = await getNextPosition('folders', restoreParentId, user.id, tx);
    await executeQuery(
      tx,
      sql`update folders
       set is_deleted = false, deleted_at = null, deletion_batch_id = null, parent_id = ${restoreParentId},
           created_by = ${restoreParentId ? root.created_by : user.id}, position = ${nextPosition}, updated_at = now()
       where id = ${folderId} and is_deleted = true`,
    );

    for (const descendant of batchFolders) {
      if (descendant.id === folderId) continue;
      await executeQuery(
        tx,
        sql`update folders
         set is_deleted = false, deleted_at = null, deletion_batch_id = null, updated_at = now()
         where id = ${descendant.id} and is_deleted = true`,
      );
    }
    if (pageIds.length > 0) {
      await executeQuery(
        tx,
        sql`update pages
         set is_deleted = false, deleted_at = null, deletion_batch_id = null, updated_at = now()
         where id = any(${sql.param(pageIds)}::uuid[]) and is_deleted = true`,
      );
    }

    const affectedAfter = await getEntityMetaUserIds(tx, 'folder', folderId);
    const metaUserIds = mergeMetaUserIds(affectedBefore, affectedAfter);
    await notifyShareRecompute({ entityType: 'folder', entityId: folderId, metaUserIds }, tx);
    const updated = await executeQuery<FolderDatabaseRowWithOwner>(
      tx,
      sql`select f.*, get_root_folder_owner(f.id) as owner_id from folders f where f.id = ${folderId}`,
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new HTTPException(500, { message: 'Failed to restore folder' });
    return {
      folder: normalizeFolderRow(updatedRow, updatedRow.owner_id),
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
      await assertEntityWorkspaceAccess(activeFolder.workspaceId, user.id);
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

  await assertEntityWorkspaceAccess(folder.workspaceId, user.id);
  if (folder.ownerId !== user.id) {
    throw new HTTPException(403, {
      message: 'You can only permanently delete folders that you own',
    });
  }

  const purged = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const lockedFolder = await executeQuery<{ owner_id: string | null }>(
      tx,
      sql`select ${deletedFolderOwnerSql} as owner_id
       from folders f
       where f.id = ${folderId} and f.is_deleted = true
       for update`,
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
    await assertEntityWorkspaceAccess(currentFolder.workspaceId, user.id, tx);
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
  await assertEntityWorkspaceAccess(folder.workspaceId, user.id);

  const body = await c.req.json().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'BodyLimitError') throw error;
    return null;
  });
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

    const nextName = typeof name === 'string' ? normalizeFolderName(name) : currentFolder.name;
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
    const result = await executeQuery<FolderDatabaseRow>(
      tx,
      sql`update folders set name = ${nextName}, icon = ${nextIcon}, parent_id = ${nextParent}, position = ${nextPosition}, updated_at = now() where id = ${folderId} returning *`,
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
      ownerId: currentFolder.ownerId,
      enumerableFolderIds: await getEnumerableFolderIds(user.id, tx),
    };
  });

  const updatedRow = updateResult.result.rows[0];
  if (!updatedRow) throw new HTTPException(500, { message: 'Failed to update folder' });
  const updated = normalizeFolderRow(updatedRow, updateResult.ownerId);
  return c.json(
    toFolderDto(updated, redactParentId(updated.parentId, updateResult.enumerableFolderIds)),
  );
});

foldersPublicRoute.post(':id/copy', publicFolderBodyLimit, async (c) => {
  const folderId = c.req.param('id');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'BodyLimitError') throw error;
    return null;
  });
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

  const copyResult = await db.transaction(async (tx) => {
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
    if (actor.kind === 'user') await assertEntityWorkspaceAccess(currentFolder.workspaceId, actor.id, tx);
    await ensureActorFolderAccess(actor, folderId, 'view', tx);
    if (parentId) await ensureActorCanCreateInFolder(actor, parentId, tx);
    await ensureNoFolderCycle(folderId, parentId, actor.id, tx);
    await persistGuestIdentity(actor, tx);
    const destinationOwnerId = await getDestinationOwnerId(
      tx,
      parentId,
      actor.kind === 'user' ? actor.id : null,
    );
    if (!destinationOwnerId) {
      throw new HTTPException(404, { message: 'Destination workspace not found' });
    }
    const result = await copyFolderRecursive(
      tx,
      folderId,
      parentId,
      destinationOwnerId,
      actor,
      currentFolder.ownerId === destinationOwnerId ? 'all' : 'non-page',
    );
    const copiedRoot = result.folder;
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
    return result;
  });
  const newFolder = copyResult.folder;
  if (!newFolder) {
    throw new HTTPException(409, {
      message: 'Source folder is no longer accessible',
      cause: { code: 'SOURCE_FOLDER_UNAVAILABLE' },
    });
  }
  return c.json({ ...newFolder, skippedRestrictedItems: copyResult.skippedRestrictedItems }, 201);
});

foldersRoute.delete(':id', async (c) => {
  const folderId = c.req.param('id');
  const user = c.get('user') as { id: string };
  const wsFolder = await getFolderById(folderId);
  if (wsFolder) await assertEntityWorkspaceAccess(wsFolder.workspaceId, user.id);
  const force = c.req.query('force') === 'true';
  const deletionResult = await moveFolderToTrash(folderId, user.id, force);

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
  const user = c.get('user') as { id: string };
  const wsFolder = await getFolderById(folderId);
  if (wsFolder) await assertEntityWorkspaceAccess(wsFolder.workspaceId, user.id);
  await removeFolderFromView(folderId, user.id);
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

      const resolvedAccess = sessionUserId
        ? await resolveEntityAccess('folder', folderId, sessionUserId, tx)
        : null;
      const publicPermission = resolvedAccess
        ? resolvedAccess.publicPermission
        : await getPublicPermission('folder', folderId, tx);
      const hasAccountAccess = Boolean(resolvedAccess?.accountPermission);
      let userPermission: SharePermission;
      let fullAccess = false;
      if (resolvedAccess) {
        if (!resolvedAccess.permission) {
          throw new HTTPException(403, { message: "You don't have access to this folder" });
        }
        userPermission = resolvedAccess.permission;
        fullAccess = resolvedAccess.fullAccess;
      } else {
        if (!publicPermission) {
          throw new HTTPException(401, { message: 'Log in to access this folder' });
        }
        userPermission = publicPermission;
      }

      if (sessionUserId && publicPermission && lockedFolder.ownerId !== sessionUserId) {
        await recordPublicVisitAndNotify(tx, 'folder', folderId, sessionUserId);
      }

      type PublicFolderPageRow = {
        id: string;
        parent_id: string | null;
        title: string;
        icon: string | null;
        created_by: string | null;
        owner_id: string | null;
        created_at: Date | string;
        updated_at: Date | string;
        public_permission: PublicPermission | null;
        user_permission: SharePermission;
      };
      type PublicFolderChildRow = {
        id: string;
        parent_id: string | null;
        name: string;
        icon: string | null;
        created_by: string | null;
        owner_id: string | null;
        created_at: Date | string;
        updated_at: Date | string;
        public_permission: PublicPermission | null;
        user_permission: SharePermission;
      };
      const pagesResult = await executeQuery<PublicFolderPageRow>(
        tx,
        sql`SELECT id, title, icon, created_by, created_at, updated_at, parent_id,
                get_public_page_permission(p.id) as public_permission,
                coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
                access.permission as user_permission
         FROM pages p
         JOIN LATERAL get_effective_page_permission(p.id, ${sessionUserId}::uuid) access ON true
         WHERE parent_id = ${folderId} AND is_deleted = false
           AND access.permission IS NOT NULL
         ORDER BY position::numeric ASC`,
      );
      const foldersResult = await executeQuery<PublicFolderChildRow>(
        tx,
        sql`SELECT id, parent_id, name, icon, created_by, created_at, updated_at,
                get_public_folder_permission(f.id) as public_permission,
                get_root_folder_owner(f.id) as owner_id,
                access.permission as user_permission
         FROM folders f
         JOIN LATERAL get_effective_folder_permission(f.id, ${sessionUserId}::uuid) access ON true
         WHERE parent_id = ${folderId} AND is_deleted = false
           AND access.permission IS NOT NULL
         ORDER BY position::numeric ASC`,
      );

      const enumerableFolderIds =
        sessionUserId && hasAccountAccess
          ? await getEnumerableFolderIds(sessionUserId, tx)
          : new Set<string>();

      const pages = pagesResult.rows.map((page) => {
        return {
          accessScope: 'account' as const,
          id: page.id,
          parentId: page.parent_id,
          title: page.title,
          icon: page.icon,
          createdBy: page.created_by,
          ownerId: page.owner_id,
          createdAt: serializeTimestamp(page.created_at),
          updatedAt: serializeTimestamp(page.updated_at),
          publicPermission: page.public_permission,
          userPermission: page.user_permission,
        } satisfies AccountFolderPayload['pages'][number];
      });
      const childFolders = foldersResult.rows.map((folder) => {
        return {
          accessScope: 'account' as const,
          id: folder.id,
          parentId: folder.parent_id,
          name: folder.name,
          icon: folder.icon,
          createdBy: folder.created_by,
          ownerId: folder.owner_id,
          createdAt: serializeTimestamp(folder.created_at),
          updatedAt: serializeTimestamp(folder.updated_at),
          publicPermission: folder.public_permission,
          userPermission: folder.user_permission,
        } satisfies AccountFolderPayload['folders'][number];
      });

      if (!hasAccountAccess) {
        if (!publicPermission) {
          throw new HTTPException(403, { message: 'You do not have public access to this folder' });
        }
        const publicPages = pages.flatMap((page) =>
          page.publicPermission
            ? [
                {
                  accessScope: 'public',
                  id: page.id,
                  title: page.title,
                  icon: page.icon,
                  updatedAt: serializeTimestamp(page.updatedAt),
                  publicPermission: page.publicPermission,
                  userPermission: page.publicPermission,
                } satisfies PublicFolderPayload['pages'][number],
              ]
            : [],
        );
        const publicChildFolders = childFolders.flatMap((folder) =>
          folder.publicPermission
            ? [
                {
                  accessScope: 'public',
                  id: folder.id,
                  name: folder.name,
                  icon: folder.icon,
                  updatedAt: serializeTimestamp(folder.updatedAt),
                  publicPermission: folder.publicPermission,
                  userPermission: folder.publicPermission,
                } satisfies PublicFolderPayload['folders'][number],
              ]
            : [],
        );
        return toPublicFolderDto(
          lockedFolder,
          publicPermission,
          publicPermission,
          publicPages,
          publicChildFolders,
        );
      }

      return {
        accessScope: 'account' as const,
        ...toFolderDto(lockedFolder, redactParentId(lockedFolder.parentId, enumerableFolderIds)),
        createdAt: serializeTimestamp(lockedFolder.createdAt),
        updatedAt: serializeTimestamp(lockedFolder.updatedAt),
        publicPermission,
        userPermission,
        capabilities: deriveCapabilities(userPermission, fullAccess),
        pages,
        folders: childFolders,
      } satisfies AccountFolderPayload;
    });

    return c.json(result);
  },
);

foldersPublicRoute.post(':id/access', publicFolderBodyLimit, async (c) => {
  const folderId = c.req.param('id');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
  await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'folder', folderId);
    const folder = await getFolderById(folderId, tx);
    if (!folder) throw new HTTPException(404, { message: 'Folder not found' });
    const publicPermission = await getPublicPermission('folder', folderId, tx);
    if (sessionUserId) {
      await ensureFolderAccess(folderId, sessionUserId, 'view', tx);
      if (publicPermission && folder.ownerId !== sessionUserId) {
        await recordPublicVisitAndNotify(tx, 'folder', folderId, sessionUserId);
      }
    } else if (!publicPermission) {
      throw new HTTPException(401, { message: 'Log in to access this folder' });
    }
  });

  return c.json({ ok: true });
});

export { foldersPublicRoute };
export default foldersRoute;
