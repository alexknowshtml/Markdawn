import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';

const tagsRoute = new Hono();
tagsRoute.use('*', requireAuth);

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );
  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

tagsRoute.get('/', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    `select c.target_slug as id,
            trim(leading '#' from c.target_slug) as name,
            count(distinct c.source_id) as page_count
     from connections c
     join pages p on p.id = c.source_id
     where c.workspace_id = $1
       and c.connection_type = 'tag'
       and p.is_deleted = false
     group by c.target_slug
     order by page_count desc, name asc`,
    [workspaceId],
  );

  return c.json(result.rows);
});

tagsRoute.get('/pages', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  const tagId = c.req.query('tagId');

  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }
  if (!tagId) {
    throw new HTTPException(400, { message: 'tagId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    `select p.id, p.title, p.icon, p.parent_id as "parentId"
     from pages p
     join connections c on c.source_id = p.id
     where c.target_slug = $1
       and c.workspace_id = $2
       and c.connection_type = 'tag'
       and p.is_deleted = false
     order by p.updated_at desc`,
    [tagId.startsWith('#') ? tagId : `#${tagId}`, workspaceId],
  );

  return c.json(result.rows);
});

export default tagsRoute;
