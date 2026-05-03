import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { marked } from 'marked';
import type { pages } from '../db';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { markdownToYjsState, stripLeadingH1 } from '../utils/markdown-to-yjs';

type PageRow = typeof pages.$inferSelect;
type RawPageRow = PageRow & {
  workspace_id?: string | null;
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
};

const pagesRoute = new Hono();

pagesRoute.use('*', requireAuth);

const markdownToHtml = (markdown: string): string => {
  return marked.parse(markdown, { async: false }) as string;
};

const isValidMarkdown = (markdown: string): boolean => {
  try {
    marked.parse(markdown, { async: false });
    return true;
  } catch {
    return false;
  }
};

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

const getPageById = async (pageId: string) => {
  const result = await pool.query('select * from pages where id = $1 limit 1', [pageId]);
  const row = (result.rows[0] as RawPageRow | undefined) ?? null;
  return row ? normalizePageRow(row) : null;
};

const normalizePageRow = (row: RawPageRow): PageRow => ({
  ...row,
  workspaceId: row.workspaceId ?? row.workspace_id ?? null,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
});

function ensureWorkspaceForPage(page: PageRow): asserts page is PageRow & { workspaceId: string } {
  if (!page.workspaceId) {
    throw new HTTPException(400, { message: 'Page has no workspace' });
  }
}

pagesRoute.get('/tree', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    'select * from pages where workspace_id = $1 and is_deleted = false order by parent_id nulls first, case when parent_id is null then updated_at end desc nulls last, position asc',
    [workspaceId],
  );

  const pagesList = (result.rows as RawPageRow[]).map(normalizePageRow);
  return c.json(
    pagesList.map((page) => ({
      ...page,
      ydoc: page.ydoc ? Array.from(page.ydoc) : null,
      children: [],
    })),
  );
});

pagesRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { workspaceId, parentId, title, icon } = body as {
    workspaceId?: string;
    parentId?: string | null;
    title?: string;
    icon?: string | null;
  };

  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  if (parentId) {
    const folderResult = await pool.query(
      'select id from folders where id = $1 and workspace_id = $2 and is_deleted = false limit 1',
      [parentId, workspaceId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2'
      : 'select max(position) as max_position from pages where workspace_id = $1 and parent_id is null',
    parentId ? [workspaceId, parentId] : [workspaceId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    'insert into pages (workspace_id, parent_id, title, icon, position, created_by) values ($1, $2, $3, $4, $5, $6) returning *',
    [
      workspaceId,
      parentId ?? null,
      typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Untitled',
      typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
      nextPosition,
      user.id,
    ],
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create page' });
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.get('/trash', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    'select * from pages where workspace_id = $1 and is_deleted = true order by deleted_at desc nulls last, position asc',
    [workspaceId],
  );

  return c.json((result.rows as RawPageRow[]).map(normalizePageRow));
});

pagesRoute.delete('/trash/empty-all', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const workspacePages = await pool.query(
    'select id, parent_id, is_deleted from pages where workspace_id = $1',
    [workspaceId],
  );

  const childMap = new Map<string, string[]>();
  const trashedPageIds = new Set<string>();

  for (const item of workspacePages.rows as {
    id: string;
    parent_id: string | null;
    is_deleted: boolean;
  }[]) {
    if (item.is_deleted) {
      trashedPageIds.add(item.id);
    }
    if (!item.parent_id) {
      continue;
    }
    const list = childMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childMap.set(item.parent_id, list);
  }

  const toDelete = new Set<string>();
  const stack = Array.from(trashedPageIds);
  while (stack.length) {
    const current = stack.pop();
    if (!current || toDelete.has(current)) {
      continue;
    }
    toDelete.add(current);
    const children = childMap.get(current);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  if (toDelete.size > 0) {
    await pool.query('delete from pages where id = any($1)', [Array.from(toDelete)]);
  }

  return c.json({ deleted: true, count: toDelete.size });
});

pagesRoute.get('/recent', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const limitParam = c.req.query('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 10;
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    throw new HTTPException(400, { message: 'limit must be a positive integer' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    'select p.id, p.title, p.icon, pv.visited_at as "visitedAt" from page_visits pv join pages p on p.id = pv.page_id where pv.user_id = $1 and p.workspace_id = $2 and p.is_deleted = false order by pv.visited_at desc limit $3',
    [user.id, workspaceId, parsedLimit],
  );

  return c.json(
    result.rows as { id: string; title: string; icon: string | null; visitedAt: Date }[],
  );
});

pagesRoute.get(':id', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  await pool.query(
    'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
    [user.id, pageId],
  );

  return c.json({ ...page, ydoc: page.ydoc ? Array.from(page.ydoc) : null });
});

pagesRoute.patch(':id', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { title, icon, parentId, position, coverType, coverValue, properties } = body as {
    title?: string;
    icon?: string | null;
    parentId?: string | null;
    position?: string | number;
    coverType?: string | null;
    coverValue?: string | null;
    properties?: Record<string, unknown> | null;
  };

  const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parentId');
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const folderResult = await pool.query(
      'select id from folders where id = $1 and workspace_id = $2 and is_deleted = false limit 1',
      [parentId, page.workspaceId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const nextTitle =
    typeof title === 'string' ? (title.trim().length > 0 ? title.trim() : 'Untitled') : page.title;
  const nextIcon =
    typeof icon === 'string'
      ? icon.trim().length > 0
        ? icon.trim()
        : null
      : icon === null
        ? null
        : page.icon;
  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition =
    typeof position === 'string'
      ? position.trim().length > 0
        ? position.trim()
        : page.position
      : typeof position === 'number' && Number.isFinite(position)
        ? String(position)
        : page.position;
  const hasCoverType = Object.prototype.hasOwnProperty.call(body, 'coverType');
  const hasCoverValue = Object.prototype.hasOwnProperty.call(body, 'coverValue');
  const hasProperties = Object.prototype.hasOwnProperty.call(body, 'properties');
  const nextCoverType = hasCoverType
    ? typeof coverType === 'string' && coverType.trim().length > 0
      ? coverType.trim()
      : null
    : page.coverType;
  const nextCoverValue = hasCoverValue
    ? typeof coverValue === 'string' && coverValue.trim().length > 0
      ? coverValue.trim()
      : null
    : page.coverValue;
  const nextProperties = hasProperties
    ? properties && typeof properties === 'object'
      ? JSON.stringify(properties)
      : null
    : page.properties;

  const updateResult = hasProperties
    ? await pool.query(
        'update pages set title = $1, icon = $2, parent_id = $3, position = $4, cover_type = $5, cover_value = $6, properties = $7, updated_at = now() where id = $8 returning *',
        [
          nextTitle,
          nextIcon,
          nextParent,
          nextPosition,
          nextCoverType,
          nextCoverValue,
          nextProperties,
          pageId,
        ],
      )
    : await pool.query(
        'update pages set title = $1, icon = $2, parent_id = $3, position = $4, cover_type = $5, cover_value = $6, updated_at = now() where id = $7 returning *',
        [nextTitle, nextIcon, nextParent, nextPosition, nextCoverType, nextCoverValue, pageId],
      );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to update page' });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(':id/restore', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const updateResult = await pool.query(
    'update pages set is_deleted = false, deleted_at = null, updated_at = now() where id = $1 returning *',
    [pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to restore page' });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(':id/move', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, position } = body as {
    parentId?: string | null;
    position?: string | number;
  };

  const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parentId');
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const folderResult = await pool.query(
      'select id from folders where id = $1 and workspace_id = $2 and is_deleted = false limit 1',
      [parentId, page.workspaceId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition =
    typeof position === 'string'
      ? position.trim().length > 0
        ? position.trim()
        : page.position
      : typeof position === 'number' && Number.isFinite(position)
        ? String(position)
        : page.position;

  const updateResult = await pool.query(
    'update pages set parent_id = $1, position = $2, updated_at = now() where id = $3 returning *',
    [nextParent, nextPosition, pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to move page' });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.get(':id/export/markdown', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const filename = `${page.title || 'Untitled'}.md`;
  c.header('Content-Type', 'text/markdown');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  if (!page.ydoc || page.ydoc.length === 0) {
    return c.body('');
  }

  try {
    const decoded = new TextDecoder().decode(page.ydoc);
    c.header('Content-Type', 'text/markdown');
    return c.body(decoded);
  } catch {
    throw new HTTPException(500, { message: 'Failed to decode page content' });
  }
});

pagesRoute.post(':id/import/markdown', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const contentType = c.req.header('content-type') ?? '';
  let markdown = '';

  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Invalid body' });
    }
    const bodyMarkdown = (body as { markdown?: string }).markdown;
    markdown = typeof bodyMarkdown === 'string' ? bodyMarkdown : '';
  } else if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: 'File is required' });
    }
    markdown = await file.text();
  } else {
    throw new HTTPException(415, { message: 'Unsupported content type' });
  }

  if (!markdown.trim()) {
    throw new HTTPException(400, { message: 'Markdown is required' });
  }

  if (!isValidMarkdown(markdown)) {
    throw new HTTPException(400, { message: 'Invalid markdown format' });
  }

  const contentForEditor = page.title ? stripLeadingH1(markdown, page.title) : markdown;
  const ydocBuffer = Buffer.from(markdownToYjsState(contentForEditor));

  const updateResult = await pool.query(
    'update pages set ydoc = $1, updated_at = now() where id = $2',
    [ydocBuffer, pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to import page content' });
  }

  return c.json({ success: true });
});

pagesRoute.delete(':id', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const updateResult = await pool.query(
    'update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
    [pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to delete page' });
  }

  return c.json({ deleted: true });
});

pagesRoute.post(':id/copy', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;

  if (parentId) {
    const folderResult = await pool.query(
      'select id from folders where id = $1 and workspace_id = $2 and is_deleted = false limit 1',
      [parentId, page.workspaceId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2'
      : 'select max(position) as max_position from pages where workspace_id = $1 and parent_id is null',
    parentId ? [page.workspaceId, parentId] : [page.workspaceId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    `insert into pages (id, workspace_id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by)
     select gen_random_uuid(), workspace_id, $1, $2, icon, cover_type, cover_value, $3, ydoc, $4
     from pages where id = $5
     returning *`,
    [parentId ?? null, `Copy of ${page.title}`, nextPosition, user.id, pageId],
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to copy page' });
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.delete(':id/permanent', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  ensureWorkspaceForPage(page);
  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspaceId, user.id);

  const workspacePages = await pool.query(
    'select id, parent_id from pages where workspace_id = $1',
    [page.workspaceId],
  );

  const childMap = new Map<string, string[]>();
  for (const item of workspacePages.rows as { id: string; parent_id: string | null }[]) {
    if (!item.parent_id) {
      continue;
    }
    const list = childMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childMap.set(item.parent_id, list);
  }

  const toDelete = new Set<string>();
  const stack = [pageId];
  while (stack.length) {
    const current = stack.pop();
    if (!current || toDelete.has(current)) {
      continue;
    }
    toDelete.add(current);
    const children = childMap.get(current);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  await pool.query('delete from pages where id = any($1)', [Array.from(toDelete)]);

  return c.json({ deleted: true });
});

export default pagesRoute;
