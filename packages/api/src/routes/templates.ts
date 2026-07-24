import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';

const templatesRoute = new Hono();

templatesRoute.use('*', requireAuth);

templatesRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    sql`select id, title, icon, description, content_blocks as "contentBlocks", created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt" from templates where created_by = ${user.id} order by created_at desc`,
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

  const result = await query(
    sql`insert into templates (title, icon, description, content_blocks, created_by)
     values (${title.trim()}, ${icon ?? null}, ${description ?? null}, ${JSON.stringify(contentBlocks)}, ${user.id})
     returning id, title, icon, description, content_blocks as "contentBlocks", created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"`,
  );

  return c.json(result.rows[0], 201);
});

templatesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user') as { id: string };

  const templateResult = await query(
    sql`select created_by from templates where id = ${id} limit 1`,
  );

  if (templateResult.rowCount === 0) {
    throw new HTTPException(404, { message: 'Template not found' });
  }

  const templateRow = templateResult.rows[0];
  if (!templateRow) {
    throw new HTTPException(404, { message: 'Template not found' });
  }

  const ownerId = templateRow.created_by;
  if (ownerId !== user.id) {
    throw new HTTPException(403, { message: 'You can only delete your own templates' });
  }

  await query(sql`delete from templates where id = ${id}`);

  return c.json({ success: true });
});

export default templatesRoute;
