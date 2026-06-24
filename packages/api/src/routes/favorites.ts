import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { ensurePageAccess } from '../utils/share-access';

type FavoriteRow = {
  page_id: string;
  title: string;
  icon: string | null;
  created_at: Date | null;
};

const favoritesRoute = new Hono();

favoritesRoute.use('*', requireAuth);

favoritesRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    'select uf.page_id, p.title, p.icon, uf.created_at from user_favorites uf join pages p on p.id = uf.page_id where uf.user_id = $1 and p.is_deleted = false order by uf.created_at desc nulls last',
    [user.id],
  );

  const favorites = (result.rows as FavoriteRow[]).map((row) => ({
    pageId: row.page_id,
    title: row.title,
    icon: row.icon,
    createdAt: row.created_at,
  }));

  return c.json({ favorites });
});

favoritesRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { pageId } = body as { pageId?: string };
  if (!pageId) {
    throw new HTTPException(400, { message: 'pageId is required' });
  }

  const pageResult = await query('select id, is_deleted from pages where id = $1 limit 1', [
    pageId,
  ]);
  const page = pageResult.rows[0] as { id: string; is_deleted: boolean | null } | undefined;
  if (!page || page.is_deleted) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  const insertResult = await query(
    'insert into user_favorites (user_id, page_id) values ($1, $2) on conflict (user_id, page_id) do nothing returning id',
    [user.id, pageId],
  );

  if (insertResult.rowCount === 0) {
    return c.json({ ok: true });
  }

  return c.json({ ok: true }, 201);
});

favoritesRoute.delete(':pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const pageResult = await query('select id from pages where id = $1 limit 1', [pageId]);
  if (!pageResult.rows[0]) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  await query('delete from user_favorites where user_id = $1 and page_id = $2', [user.id, pageId]);

  return c.json({ deleted: true });
});

export default favoritesRoute;
