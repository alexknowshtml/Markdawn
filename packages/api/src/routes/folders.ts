import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { folders } from '../db';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';

type FolderRow = typeof folders.$inferSelect;
type RawFolderRow = FolderRow & {
  workspace_id?: string | null;
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  is_deleted?: boolean | null;
  deleted_at?: Date | null;
};

const foldersRoute = new Hono();

foldersRoute.use('*', requireAuth);

const normalizeFolderRow = (row: RawFolderRow): FolderRow => ({
  ...row,
  workspaceId: row.workspaceId ?? row.workspace_id ?? null,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
  isDeleted: row.isDeleted ?? row.is_deleted ?? false,
  deletedAt: row.deletedAt ?? row.deleted_at ?? null,
});

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

function ensureFolderWorkspace(
  folder: FolderRow,
): asserts folder is FolderRow & { workspaceId: string } {
  if (!folder.workspaceId) {
    throw new HTTPException(400, { message: 'Folder has no workspace' });
  }
}

const getFolderById = async (folderId: string) => {
  const result = await pool.query('select * from folders where id = $1 limit 1', [folderId]);
  const row = (result.rows[0] as RawFolderRow | undefined) ?? null;
  return row ? normalizeFolderRow(row) : null;
};

const ensureNoFolderCycle = async (
  workspaceId: string,
  folderId: string,
  targetParentId: string | null,
) => {
  if (!targetParentId) {
    return;
  }

  const result = await pool.query(
    'select id, parent_id from folders where workspace_id = $1 and is_deleted = false',
    [workspaceId],
  );

  const parentById = new Map<string, string | null>();
  for (const row of result.rows as { id: string; parent_id: string | null }[]) {
    parentById.set(row.id, row.parent_id ?? null);
  }

  let current: string | null = targetParentId;
  const visited = new Set<string>();

  while (current) {
    if (current === folderId) {
      throw new HTTPException(400, { message: 'Cannot move folder into its own subtree' });
    }
    if (visited.has(current)) {
      throw new HTTPException(400, { message: 'Invalid folder hierarchy detected' });
    }
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
};

const buildFolderTree = (rows: FolderRow[]) => {
  type FolderNode = FolderRow & { children: FolderNode[] };
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
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    'select * from folders where workspace_id = $1 and is_deleted = false order by parent_id nulls first, case when parent_id is null then updated_at end desc nulls last, position asc',
    [workspaceId],
  );

  return c.json(buildFolderTree((result.rows as RawFolderRow[]).map(normalizeFolderRow)));
});

foldersRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { workspaceId, parentId, name, icon } = body as {
    workspaceId?: string;
    parentId?: string | null;
    name?: string;
    icon?: string | null;
  };

  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  if (parentId) {
    const parent = await getFolderById(parentId);
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    if (parent.isDeleted) {
      throw new HTTPException(400, { message: 'Cannot create inside a deleted folder' });
    }
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from folders where workspace_id = $1 and parent_id = $2'
      : 'select max(position) as max_position from folders where workspace_id = $1 and parent_id is null',
    parentId ? [workspaceId, parentId] : [workspaceId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    'insert into folders (workspace_id, parent_id, name, icon, position, created_by) values ($1, $2, $3, $4, $5, $6) returning *',
    [
      workspaceId,
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
  ensureFolderWorkspace(folder);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(folder.workspaceId, user.id);

  return c.json(folder);
});

foldersRoute.patch(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  ensureFolderWorkspace(folder);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(folder.workspaceId, user.id);

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

  const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parentId');
  if (hasParentId && parentId) {
    if (parentId === folder.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const parent = await getFolderById(parentId);
    if (!parent || parent.workspaceId !== folder.workspaceId) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }

    if (parent.isDeleted) {
      throw new HTTPException(400, { message: 'Cannot move into a deleted folder' });
    }
  }

  const nextParent = hasParentId ? (parentId ?? null) : folder.parentId;
  await ensureNoFolderCycle(folder.workspaceId, folder.id, nextParent);

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

  const updateResult = await pool.query(
    'update folders set name = $1, icon = $2, parent_id = $3, position = $4, updated_at = now() where id = $5 returning *',
    [nextName, nextIcon, nextParent, nextPosition, folderId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to update folder' });
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
  ensureFolderWorkspace(folder);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(folder.workspaceId, user.id);

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
    if (!parent || parent.workspaceId !== folder.workspaceId) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    if (parent.isDeleted) {
      throw new HTTPException(400, { message: 'Cannot move into a deleted folder' });
    }
  }

  await ensureNoFolderCycle(folder.workspaceId, folder.id, parentId);

  await pool.query('BEGIN');

  try {
    const newFolder = await copyFolderRecursive(folderId, parentId, folder.workspaceId, user.id);
    await pool.query('COMMIT');
    return c.json(newFolder, 201);
  } catch (err) {
    await pool.query('ROLLBACK');
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : 'Failed to copy folder',
    });
  }
});

async function copyFolderRecursive(
  sourceFolderId: string,
  newParentId: string | null,
  workspaceId: string,
  userId: string,
): Promise<FolderRow> {
  const sourceResult = await pool.query('select * from folders where id = $1', [sourceFolderId]);
  const source = normalizeFolderRow(sourceResult.rows[0] as RawFolderRow);

  const positionResult = await pool.query(
    newParentId
      ? 'select max(position) as max_position from folders where workspace_id = $1 and parent_id = $2'
      : 'select max(position) as max_position from folders where workspace_id = $1 and parent_id is null',
    newParentId ? [workspaceId, newParentId] : [workspaceId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    `insert into folders (id, workspace_id, parent_id, name, icon, position, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
     returning *`,
    [workspaceId, newParentId ?? null, `Copy of ${source.name}`, source.icon, nextPosition, userId],
  );
  const newFolder = normalizeFolderRow(insertResult.rows[0] as RawFolderRow);

  const pagesResult = await pool.query(
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
    await pool.query(
      `insert into pages (id, workspace_id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        workspaceId,
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

  const subfoldersResult = await pool.query(
    'select id from folders where parent_id = $1 and is_deleted = false',
    [sourceFolderId],
  );
  for (const subfolderRow of subfoldersResult.rows) {
    await copyFolderRecursive(
      (subfolderRow as { id: string }).id,
      newFolder.id,
      workspaceId,
      userId,
    );
  }

  return newFolder;
}

foldersRoute.delete(':id', async (c) => {
  const folderId = c.req.param('id');
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  ensureFolderWorkspace(folder);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(folder.workspaceId, user.id);

  const directChildFolders = await pool.query(
    'select id from folders where parent_id = $1 and is_deleted = false',
    [folderId],
  );
  const directChildPages = await pool.query(
    'select id from pages where parent_id = $1 and is_deleted = false',
    [folderId],
  );

  const hasChildren =
    (directChildFolders.rowCount ?? 0) > 0 || (directChildPages.rowCount ?? 0) > 0;

  if (hasChildren) {
    const force = c.req.query('force') === 'true';

    if (!force) {
      return c.json({
        requiresForce: true,
        childFolders: directChildFolders.rowCount ?? 0,
        childPages: directChildPages.rowCount ?? 0,
        message: 'Folder is not empty. Add ?force=true to delete contents as well.',
      });
    }

    const childFolderIds = (directChildFolders.rows as { id: string }[]).map((r) => r.id);
    for (const childFolderId of childFolderIds) {
      await pool.query(
        'update folders set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
        [childFolderId],
      );
    }

    const childPageIds = (directChildPages.rows as { id: string }[]).map((r) => r.id);
    for (const childPageId of childPageIds) {
      await pool.query(
        'update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
        [childPageId],
      );
    }
  }

  const updateResult = await pool.query(
    'update folders set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
    [folderId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to delete folder' });
  }

  return c.json({ deleted: true });
});

export default foldersRoute;
