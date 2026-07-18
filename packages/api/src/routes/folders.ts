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
  is_public?: boolean | null;
  public_token?: string | null;
  inheritance_policy?: 'inherit' | 'restricted' | null;
};

type LinkPermission = 'view' | 'edit';
type FolderLinkAccess = {
  permission: LinkPermission;
  token: string;
  sourceId: string;
};

const getPresentedShareToken = (c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): string | null => {
  const token = c.req.header('x-share-token') ?? c.req.query('share') ?? null;
  const trimmed = token?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

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
  isPublic: row.isPublic ?? row.is_public ?? false,
  publicToken: row.publicToken ?? row.public_token ?? null,
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
  isPublic: folder.isPublic,
  inheritancePolicy: folder.inheritancePolicy,
});

type PublicFolderPageDto = {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: Date | null;
};

type PublicFolderChildDto = {
  id: string;
  name: string;
  icon: string | null;
  updatedAt: Date | null;
};

const toPublicFolderDto = (
  folder: NormalizedFolderRow,
  linkAccess: FolderLinkAccess,
  pages: readonly PublicFolderPageDto[],
  childFolders: readonly PublicFolderChildDto[],
) => ({
  id: folder.id,
  name: folder.name,
  icon: folder.icon,
  updatedAt: folder.updatedAt,
  isPublic: true,
  linkPermission: linkAccess.permission,
  pages,
  folders: childFolders,
});

const toAuthenticatedFolderDto = (
  folder: NormalizedFolderRow,
  parentId: string | null,
  linkAccess: FolderLinkAccess | null,
  userPermission: SharePermission,
  capabilities: ReturnType<typeof deriveCapabilities>,
  pages: readonly Record<string, unknown>[],
  childFolders: readonly Record<string, unknown>[],
) => ({
  ...toFolderDto(folder, parentId),
  isPublic: folder.isPublic || !!linkAccess,
  linkPermission: linkAccess?.permission ?? null,
  userPermission,
  capabilities,
  pages,
  folders: childFolders,
});

const normalizeLinkPermission = (permission: string | null | undefined): LinkPermission => {
  return permission === 'edit' || permission === 'admin' ? 'edit' : 'view';
};

const getFolderLinkAccesses = async (
  folderId: string,
  executor?: QueryExecutor,
): Promise<FolderLinkAccess[]> => {
  const statement = `
      select
        coalesce(s.permission, 'view') as permission,
        coalesce(s.token, f.public_token, f.id::text) as token,
        f.id as source_id
      from folder_closure fc
      join folders f on f.id = fc.ancestor_id and f.is_deleted = false
      join lateral (
        select permission, token
        from shares
        where entity_type = 'folder'
          and entity_id = f.id
          and token is not null
          and (expires_at is null or expires_at > statement_timestamp())
        order by updated_at desc nulls last
        limit 1
      ) s on true
      where fc.descendant_id = $1
        and f.is_public = true
        and not is_folder_inheritance_blocked(f.id, $1)
      order by
        case coalesce(s.permission, 'view')
          when 'admin' then 3
          when 'edit' then 2
          else 1
        end desc,
        fc.depth asc
    `;
  const result = executor
    ? await executeQuery(executor, statement, [folderId])
    : await query(statement, [folderId]);

  return result.rows.flatMap((value) => {
    const row = value as {
      permission?: string | null;
      token?: string | null;
      source_id?: string | null;
    };
    if (!row.token || !row.source_id) return [];
    return [
      {
        permission: normalizeLinkPermission(row.permission),
        token: row.token,
        sourceId: row.source_id,
      } satisfies FolderLinkAccess,
    ];
  });
};

const recordFolderLinkAccesses = async (
  executor: QueryExecutor,
  userId: string,
  linkAccesses: readonly FolderLinkAccess[],
): Promise<boolean> => {
  let insertedAny = false;
  for (const linkAccess of linkAccesses) {
    const insertResult = await executeQuery(
      executor,
      `insert into folder_access_events
         (folder_id, user_id, source, token, permission, first_seen_at, last_seen_at)
       values ($1, $2, 'link', $3, $4, now(), now())
       on conflict (folder_id, user_id, source, token)
       do nothing
       returning id`,
      [linkAccess.sourceId, userId, linkAccess.token, linkAccess.permission],
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      await executeQuery(
        executor,
        `update folder_access_events
         set permission = $1, last_seen_at = now()
         where folder_id = $2 and user_id = $3 and source = 'link' and token = $4`,
        [linkAccess.permission, linkAccess.sourceId, userId, linkAccess.token],
      );
    } else {
      insertedAny = true;
    }
  }
  return insertedAny;
};

const findFolderLinkAccessByToken = (
  accesses: readonly FolderLinkAccess[],
  token: string | null,
) => {
  if (!token) return null;
  return accesses.find((access) => access.token === token) ?? null;
};

const hasNonLinkFolderAccess = async (
  folderId: string,
  userId: string,
  executor?: QueryExecutor,
): Promise<boolean> => {
  const statement = `with folder_info as (
       select get_root_folder_owner($1) as owner_id
       where exists (select 1 from folders where id = $1 and is_deleted = false)
     )
     select exists (
       select 1 from folder_info where owner_id = $2
       union all
       select 1
       from shares s
       where s.entity_type = 'folder'
         and s.entity_id = $1
         and s.recipient_user_id = $2
         and s.token is null
         and (s.expires_at is null or s.expires_at > statement_timestamp())
       union all
       select 1
       from shares s
       join folders source_folder on source_folder.id = s.entity_id
       where s.entity_type = 'folder'
         and s.entity_id in (
           select ancestor_id
           from folder_closure
           where descendant_id = $1 and ancestor_id != $1
         )
         and s.recipient_user_id = $2
         and s.token is null
         and source_folder.is_deleted = false
         and (s.expires_at is null or s.expires_at > statement_timestamp())
         and not is_folder_inheritance_blocked(s.entity_id, $1)
       union all
       select 1
       from folder_info info
       join workspace_members member on member.workspace_owner_id = info.owner_id
       where member.member_id = $2
         and not is_folder_path_restricted($1)
     ) as has_access`;
  const result = executor
    ? await executeQuery(executor, statement, [folderId, userId])
    : await query(statement, [folderId, userId]);
  return result.rows[0]?.has_access === true;
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
             perm.permission as user_permission,
             exists (
               select 1 from workspace_members wm
               where wm.workspace_owner_id = get_root_folder_owner(f.id)
                 and wm.member_id = $1
                 and not is_folder_path_restricted(f.id)
             ) as workspace_access
      from folders f
      join lateral (
        select permission
        from (
          select 'admin'::text as permission, 1 as src
          where get_root_folder_owner(f.id) = $1

          union all

          select s.permission, 2 as src
          from shares s
          where s.entity_type = 'folder'
            and s.entity_id = f.id
            and s.recipient_user_id = $1
            and s.token is null
            and (s.expires_at is null or s.expires_at > statement_timestamp())

          union all

          select s.permission, 3 as src
          from shares s
          join folders source_folder on source_folder.id = s.entity_id
          where s.entity_type = 'folder'
            and s.entity_id in (
              select ancestor_id
              from folder_closure
              where descendant_id = f.id and ancestor_id != f.id
            )
            and s.recipient_user_id = $1
            and s.token is null
            and source_folder.is_deleted = false
            and (s.expires_at is null or s.expires_at > statement_timestamp())
            and not is_folder_inheritance_blocked(s.entity_id, f.id)

          union all

          select s.permission, 4 as src
          from folder_access_events fae
          join shares s
            on s.entity_type = 'folder'
           and s.entity_id = fae.folder_id
           and s.token = fae.token
           and s.token is not null
          join folders source_folder on source_folder.id = fae.folder_id
          where fae.user_id = $1
            and fae.source = 'link'
            and source_folder.is_public = true
            and source_folder.is_deleted = false
            and (s.expires_at is null or s.expires_at > statement_timestamp())
            and f.id in (
              select descendant_id
              from folder_closure
              where ancestor_id = fae.folder_id
            )
            and not is_folder_inheritance_blocked(fae.folder_id, f.id)

          union all

          select case wm.role when 'viewer' then 'view' when 'editor' then 'edit' when 'admin' then 'admin' end, 5 as src
          from workspace_members wm
          where wm.workspace_owner_id = get_root_folder_owner(f.id)
            and wm.member_id = $1
            and not is_folder_path_restricted(f.id)
        ) perms
        order by case perms.permission when 'admin' then 3 when 'edit' then 2 else 1 end desc,
                 perms.src asc
        limit 1
      ) perm on true
      where f.is_deleted = false
        and perm.permission is not null
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

  const insertResult = await db.transaction(async (tx) => {
    if (parentId) {
      await lockEntityAccessMutation(tx, 'folder', parentId);
      await ensureFolderAccess(parentId, user.id, 'admin', tx);
    } else {
      await lockWorkspaceAccessMutation(tx, user.id);
    }

    const nextPosition = await getNextPosition('folders', parentId ?? null, user.id, tx);
    const result = await executeQuery(
      tx,
      'insert into folders (parent_id, name, icon, position, created_by) values ($1, $2, $3, $4, $5) returning *',
      [
        parentId ?? null,
        typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'New Folder',
        typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
        nextPosition,
        user.id,
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

foldersRoute.post(':id/copy', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  const user = c.get('user') as { id: string };
  await ensureFolderAccess(folder.id, user.id);

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
    await ensureFolderAccess(parent.id, user.id, 'admin');
  }

  await ensureNoFolderCycle(folder.id, parentId, user.id);

  const copyState = { skippedRestrictedItems: false };
  const newFolder = await db.transaction(async (tx) => {
    await lockEntityAccessMutations(
      tx,
      [
        { entityType: 'folder', entityId: folderId },
        ...(parentId ? [{ entityType: 'folder' as const, entityId: parentId }] : []),
      ],
      parentId ? [] : [user.id],
    );
    await ensureFolderAccess(folderId, user.id, 'view', tx);
    if (parentId) await ensureFolderAccess(parentId, user.id, 'admin', tx);
    await ensureNoFolderCycle(folderId, parentId, user.id, tx);
    const copiedRoot = await copyFolderRecursive(tx, folderId, parentId, user.id, copyState);
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
  userId: string,
  state: { skippedRestrictedItems: boolean },
): Promise<FolderRow | null> {
  const sourceResult = await executeQuery(
    executor,
    `select f.*
     from folders f
     join lateral get_effective_folder_permission(f.id, $2) access on true
     where f.id = $1 and f.is_deleted = false and access.permission is not null`,
    [sourceFolderId, userId],
  );
  const sourceRow = sourceResult.rows[0] as RawFolderRow | undefined;
  if (!sourceRow) {
    state.skippedRestrictedItems = true;
    return null;
  }
  const source = normalizeFolderRow(sourceRow);

  const nextPosition = await getNextPosition('folders', newParentId, userId, executor);

  const insertResult = await executeQuery(
    executor,
    `insert into folders (id, parent_id, name, icon, position, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)
     returning *`,
    [newParentId, `Copy of ${source.name}`, source.icon, nextPosition, userId],
  );
  const newFolder = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);

  const pagesResult = await executeQuery(
    executor,
    `select p.*, access.permission as effective_permission
     from pages p
     left join lateral get_effective_page_permission(p.id, $2) access on true
     where p.parent_id = $1 and p.is_deleted = false
     order by p.position::numeric asc`,
    [sourceFolderId, userId],
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
        userId,
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

  const subfoldersResult = await executeQuery(
    executor,
    `select f.id, access.permission as effective_permission
     from folders f
     left join lateral get_effective_folder_permission(f.id, $2) access on true
     where f.parent_id = $1 and f.is_deleted = false
     order by f.position::numeric asc`,
    [sourceFolderId, userId],
  );
  for (const subfolderRow of subfoldersResult.rows as {
    id: string;
    effective_permission: string | null;
  }[]) {
    if (!subfolderRow.effective_permission) {
      state.skippedRestrictedItems = true;
      continue;
    }
    await copyFolderRecursive(executor, subfolderRow.id, newFolder.id, userId, state);
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
      'delete from folder_access_events where folder_id = $1 and user_id = $2 returning id',
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
    const folderId = c.req.param('id');
    const shareToken = getPresentedShareToken(c);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
    const result = await db.transaction(async (tx) => {
      // Serialize the active-source lookup and provenance writes with public
      // link and hierarchy mutations for this workspace.
      await lockEntityAccess(tx, 'folder', folderId);
      const lockedFolder = await getFolderById(folderId, tx);
      if (!lockedFolder) {
        throw new HTTPException(404, { message: 'Folder not found' });
      }

      const linkAccesses = await getFolderLinkAccesses(folderId, tx);
      const activeLinkAccess = findFolderLinkAccessByToken(linkAccesses, shareToken);
      const hasAccountAccess = sessionUserId
        ? await hasNonLinkFolderAccess(folderId, sessionUserId, tx)
        : false;
      if (!hasAccountAccess && !activeLinkAccess) {
        throw new HTTPException(404, { message: 'Folder not found' });
      }
      const accountAccess =
        sessionUserId && hasAccountAccess
          ? await ensureFolderAccess(folderId, sessionUserId, 'view', tx)
          : null;

      if (sessionUserId && activeLinkAccess && lockedFolder.ownerId !== sessionUserId) {
        const insertedAny = await recordFolderLinkAccesses(
          tx,
          sessionUserId,
          activeLinkAccess.sourceId === folderId ? [activeLinkAccess] : [],
        );
        if (insertedAny) {
          await notifyShareRecompute(
            {
              entityType: 'folder',
              entityId: lockedFolder.id,
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
                coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id
         FROM pages p
         WHERE parent_id = $1 AND is_deleted = false
           AND CASE
             WHEN $2::uuid IS NOT NULL THEN EXISTS (
               SELECT 1
               FROM get_effective_page_permission(p.id, $2::uuid) access
               WHERE access.permission IS NOT NULL
             )
              ELSE $3::text IS NOT NULL AND (
               (
                 p.is_public = true
                 AND EXISTS (
                   SELECT 1 FROM shares page_link
                    WHERE page_link.entity_type = 'page'
                      AND page_link.entity_id = p.id
                      AND page_link.token IS NOT NULL
                      AND page_link.token = $3
                      AND (page_link.expires_at IS NULL OR page_link.expires_at > statement_timestamp())
                 )
               )
               OR EXISTS (
                 SELECT 1
                 FROM folder_closure fc
                 JOIN folders source_folder ON source_folder.id = fc.ancestor_id
                  JOIN shares folder_link ON folder_link.entity_type = 'folder'
                    AND folder_link.entity_id = source_folder.id
                    AND folder_link.token IS NOT NULL
                    AND folder_link.token = $3
                    AND (folder_link.expires_at IS NULL OR folder_link.expires_at > statement_timestamp())
                 WHERE fc.descendant_id = p.parent_id
                   AND source_folder.is_public = true
                   AND source_folder.is_deleted = false
                   AND NOT is_page_folder_inheritance_blocked(source_folder.id, p.id)
               )
             )
           END
         ORDER BY position::numeric ASC`,
        [folderId, sessionUserId, shareToken],
      );
      const foldersResult = await executeQuery(
        tx,
        `SELECT id, parent_id, name, icon, created_by, created_at, updated_at, is_public,
                get_root_folder_owner(f.id) as owner_id
         FROM folders f
         WHERE parent_id = $1 AND is_deleted = false
           AND CASE
             WHEN $2::uuid IS NOT NULL THEN
               f.id IN (SELECT folder_id FROM get_enumerable_folder_ids($2::uuid))
              ELSE $3::text IS NOT NULL AND EXISTS (
               SELECT 1
               FROM folder_closure fc
               JOIN folders source_folder ON source_folder.id = fc.ancestor_id
                JOIN shares folder_link ON folder_link.entity_type = 'folder'
                  AND folder_link.entity_id = source_folder.id
                  AND folder_link.token IS NOT NULL
                  AND folder_link.token = $3
                  AND (folder_link.expires_at IS NULL OR folder_link.expires_at > statement_timestamp())
               WHERE fc.descendant_id = f.id
                 AND source_folder.is_public = true
                 AND source_folder.is_deleted = false
                 AND NOT is_folder_inheritance_blocked(source_folder.id, f.id)
             )
           END
         ORDER BY position::numeric ASC`,
        [folderId, sessionUserId, shareToken],
      );

      const enumerableFolderIds = sessionUserId
        ? await getEnumerableFolderIds(sessionUserId, tx)
        : new Set<string>();
      return {
        folder: lockedFolder,
        parentId: redactParentId(lockedFolder.parentId, enumerableFolderIds),
        linkAccess: activeLinkAccess,
        hasAccountAccess,
        accountAccess,
        pages: pagesResult.rows,
        folders: foldersResult.rows,
      };
    });

    if (!result.hasAccountAccess) {
      if (!result.linkAccess) throw new HTTPException(404, { message: 'Folder not found' });
      const publicPages = result.pages.map((row) => {
        const page = row as {
          id: string;
          parent_id: string | null;
          title: string;
          icon: string | null;
          updated_at: Date | null;
        };
        return {
          id: page.id,
          title: page.title,
          icon: page.icon,
          updatedAt: page.updated_at,
        } satisfies PublicFolderPageDto;
      });
      const publicFolders = result.folders.map((row) => {
        const folder = row as {
          id: string;
          parent_id: string | null;
          name: string;
          icon: string | null;
          updated_at: Date | null;
        };
        return {
          id: folder.id,
          name: folder.name,
          icon: folder.icon,
          updatedAt: folder.updated_at,
        } satisfies PublicFolderChildDto;
      });
      return c.json(
        toPublicFolderDto(result.folder, result.linkAccess, publicPages, publicFolders),
      );
    }

    if (!result.accountAccess) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }
    const accountPages = result.pages.map((row) => {
      const page = row as {
        id: string;
        parent_id: string | null;
        title: string;
        icon: string | null;
        created_by: string | null;
        owner_id: string | null;
        created_at: Date | null;
        updated_at: Date | null;
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
      };
    });
    const accountFolders = result.folders.map((row) => {
      const folder = row as {
        id: string;
        parent_id: string | null;
        name: string;
        icon: string | null;
        created_by: string | null;
        owner_id: string | null;
        created_at: Date | null;
        updated_at: Date | null;
        is_public: boolean;
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
        isPublic: folder.is_public,
      };
    });
    return c.json(
      toAuthenticatedFolderDto(
        result.folder,
        result.parentId,
        result.linkAccess,
        result.accountAccess.permission,
        deriveCapabilities(result.accountAccess.permission, result.accountAccess.fullAccess),
        accountPages,
        accountFolders,
      ),
    );
  },
);

foldersPublicRoute.post(':id/access', async (c) => {
  const folderId = c.req.param('id');
  const shareToken = getPresentedShareToken(c);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
  await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'folder', folderId);
    const folder = await getFolderById(folderId, tx);
    if (!folder) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    const linkAccesses = await getFolderLinkAccesses(folderId, tx);
    const activeLinkAccess = findFolderLinkAccessByToken(linkAccesses, shareToken);
    if (!activeLinkAccess) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }

    if (sessionUserId && folder.ownerId !== sessionUserId) {
      const insertedAny = await recordFolderLinkAccesses(
        tx,
        sessionUserId,
        activeLinkAccess.sourceId === folderId ? [activeLinkAccess] : [],
      );
      if (insertedAny) {
        await notifyShareRecompute(
          {
            entityType: 'folder',
            entityId: folder.id,
            targetUserId: sessionUserId,
            metaUserIds: [sessionUserId],
            metaOnly: true,
          },
          tx,
        );
      }
    }
  });

  return c.json({ ok: true });
});

export { foldersPublicRoute };
export default foldersRoute;
