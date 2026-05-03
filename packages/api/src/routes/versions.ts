import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';

type PageRow = {
  id: string;
  workspace_id: string | null;
};

type VersionRow = {
  id: string;
  page_id: string | null;
  title: string | null;
  created_at: Date | null;
  created_by_name: string | null;
};

const versionsRoute = new Hono();

versionsRoute.use('*', requireAuth);

const getPageById = async (pageId: string) => {
  const result = await pool.query('select id, workspace_id from pages where id = $1 limit 1', [
    pageId,
  ]);
  return (result.rows[0] as PageRow | undefined) ?? null;
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

versionsRoute.get(':pageId/versions', async (c) => {
  const pageId = c.req.param('pageId');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  if (!page.workspace_id) {
    throw new HTTPException(400, { message: 'Page has no workspace' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const versionsResult = await pool.query(
    'select pv.id, pv.page_id, pv.title, pv.created_at, u.name as created_by_name from page_versions pv left join users u on u.id = pv.created_by where pv.page_id = $1 order by pv.created_at desc',
    [pageId],
  );

  const versions = (versionsResult.rows as VersionRow[]).map((row) => ({
    id: row.id,
    pageId: row.page_id ?? pageId,
    title: row.title ?? null,
    createdAt: row.created_at ?? null,
    createdByName: row.created_by_name ?? null,
  }));

  return c.json(versions);
});

versionsRoute.post(':pageId/versions', async (c) => {
  const pageId = c.req.param('pageId');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  if (!page.workspace_id) {
    throw new HTTPException(400, { message: 'Page has no workspace' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const body = await c.req.json();
  const title = body?.title;

  if (!title || typeof title !== 'string') {
    throw new HTTPException(400, { message: 'title is required' });
  }

  const result = await pool.query(
    "insert into page_versions (page_id, content, title, created_by) values ($1, '{}'::jsonb, $2, $3) returning id, page_id, title, created_at",
    [pageId, title.trim(), user.id],
  );

  const row = result.rows[0] as {
    id: string;
    page_id: string | null;
    title: string | null;
    created_at: Date | null;
  };

  return c.json({
    id: row.id,
    pageId: row.page_id ?? pageId,
    title: row.title ?? null,
    createdAt: row.created_at ?? null,
  });
});

versionsRoute.post(':pageId/versions/:versionId/restore', async (c) => {
  const pageId = c.req.param('pageId');
  const versionId = c.req.param('versionId');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  if (!page.workspace_id) {
    throw new HTTPException(400, { message: 'Page has no workspace' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const versionResult = await pool.query(
    'select title from page_versions where id = $1 and page_id = $2 limit 1',
    [versionId, pageId],
  );

  if (versionResult.rowCount === 0) {
    throw new HTTPException(404, { message: 'Version not found' });
  }

  const versionTitle = (versionResult.rows[0] as { title: string | null }).title ?? null;

  const updateResult = await pool.query(
    'update pages set title = $1 where id = $2 returning id, title',
    [versionTitle, pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const row = updateResult.rows[0] as { id: string; title: string | null };

  return c.json({
    id: row.id,
    title: row.title ?? null,
  });
});

export default versionsRoute;
