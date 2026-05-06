import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';

const backlinksRoute = new Hono();
backlinksRoute.use('*', requireAuth);

const ensureWorkspaceMemberForPage = async (pageId: string, userId: string) => {
  const result = await pool.query(
    `select wm.id from workspace_members wm
     join pages p on p.workspace_id = wm.workspace_id
     where p.id = $1 and wm.user_id = $2 limit 1`,
    [pageId, userId],
  );
  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

backlinksRoute.get('/', async (c) => {
  const pageId = c.req.query('pageId');
  if (!pageId) {
    throw new HTTPException(400, { message: 'pageId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMemberForPage(pageId, user.id);

  const result = await pool.query(
    `select pl.id, pl.source_page_id as "sourcePageId", pl.link_text as "linkText",
            pl.link_type as "linkType", pl.created_at as "createdAt",
            p.title as "sourceTitle", p.icon as "sourceIcon"
     from page_links pl
     join pages p on p.id = pl.source_page_id
     where pl.target_page_id = $1 and p.is_deleted = false
     order by pl.created_at desc`,
    [pageId],
  );

  return c.json(result.rows);
});

backlinksRoute.get('/outgoing', async (c) => {
  const pageId = c.req.query('pageId');
  if (!pageId) {
    throw new HTTPException(400, { message: 'pageId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMemberForPage(pageId, user.id);

  const result = await pool.query(
    `select pl.id, pl.target_page_id as "targetPageId", pl.target_title as "targetTitle",
            pl.link_text as "linkText", pl.link_type as "linkType",
            p.title as "targetPageTitle", p.icon as "targetPageIcon"
     from page_links pl
     left join pages p on p.id = pl.target_page_id
     where pl.source_page_id = $1
     order by pl.created_at desc`,
    [pageId],
  );

  return c.json(result.rows);
});

export default backlinksRoute;
