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
    `select c.id, c.source_id as "sourcePageId", c.link_text as "linkText",
            c.connection_type as "linkType", c.updated_at as "createdAt",
            p.title as "sourceTitle", p.icon as "sourceIcon"
     from connections c
     join pages p on p.id = c.source_id
     where c.target_type = 'page'
       and c.target_id = $1
       and c.connection_type in ('wikilink', 'heading', 'embed')
       and p.is_deleted = false
     order by c.updated_at desc`,
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
    `select c.id, c.target_id as "targetPageId", c.target_label as "targetTitle",
            c.link_text as "linkText", c.connection_type as "linkType",
            p.title as "targetPageTitle", p.icon as "targetPageIcon"
     from connections c
     left join pages p on p.id = c.target_id
     where c.source_id = $1
       and c.target_type = 'page'
       and c.connection_type in ('wikilink', 'heading', 'embed')
     order by c.updated_at desc`,
    [pageId],
  );

  return c.json(result.rows);
});

export default backlinksRoute;
