import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';

const templatesRoute = new Hono();

templatesRoute.use('*', requireAuth);

templatesRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await pool.query(
    'select id, title, icon, description, content_blocks as "contentBlocks", created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt" from templates where created_by = $1 order by created_at desc',
    [user.id],
  );

  return c.json(result.rows);
});

templatesRoute.post('/', async (c) => {
  const body = await c.req.json();
  const { title, icon, description, contentBlocks } = body;

  if (!title || typeof title !== 'string') {
    throw new HTTPException(400, { message: 'title is required' });
  }

  if (!Array.isArray(contentBlocks)) {
    throw new HTTPException(400, { message: 'contentBlocks must be an array' });
  }

  const user = c.get('user') as { id: string };

  const result = await pool.query(
    `insert into templates (title, icon, description, content_blocks, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, title, icon, description, content_blocks as "contentBlocks", created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"`,
    [title.trim(), icon ?? null, description ?? null, JSON.stringify(contentBlocks), user.id],
  );

  return c.json(result.rows[0], 201);
});

templatesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user') as { id: string };

  const templateResult = await pool.query(
    'select created_by from templates where id = $1 limit 1',
    [id],
  );

  if (templateResult.rowCount === 0) {
    throw new HTTPException(404, { message: 'Template not found' });
  }

  const ownerId = templateResult.rows[0].created_by;
  if (ownerId !== user.id) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }

  await pool.query('delete from templates where id = $1', [id]);

  return c.json({ success: true });
});

export default templatesRoute;
