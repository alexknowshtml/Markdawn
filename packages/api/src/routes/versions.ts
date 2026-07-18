import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { normalizePageTitle } from '../utils/pageTitle';
import { ensurePageAccess, lockEntityAccess } from '../utils/share-access';

type VersionRow = {
  id: string;
  page_id: string | null;
  title: string | null;
  created_at: Date | null;
  created_by_name: string | null;
};

const versionsRoute = new Hono();

versionsRoute.use('*', requireAuth);

const ensurePageExists = async (pageId: string) => {
  const result = await query('select id from pages where id = $1 limit 1', [pageId]);
  return !!result.rows[0];
};

versionsRoute.get(':pageId/versions', async (c) => {
  const pageId = c.req.param('pageId');
  const user = c.get('user') as { id: string };
  return db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);

    const versionsResult = await executeQuery(
      tx,
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
});

versionsRoute.post(':pageId/versions', async (c) => {
  const pageId = c.req.param('pageId');
  const exists = await ensurePageExists(pageId);

  if (!exists) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id, 'edit');

  const body = await c.req.json();
  const title = body?.title;

  if (!title || typeof title !== 'string') {
    throw new HTTPException(400, { message: 'title is required' });
  }
  const normalizedTitle = normalizePageTitle(title);

  const result = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'edit', tx);
    return executeQuery(
      tx,
      "insert into page_versions (page_id, content, title, created_by) values ($1, '{}'::jsonb, $2, $3) returning id, page_id, title, created_at",
      [pageId, normalizedTitle, user.id],
    );
  });

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
  const exists = await ensurePageExists(pageId);

  if (!exists) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id, 'edit');

  const versionResult = await query(
    'select title from page_versions where id = $1 and page_id = $2 limit 1',
    [versionId, pageId],
  );

  if (versionResult.rowCount === 0) {
    throw new HTTPException(404, { message: 'Version not found' });
  }

  const versionTitle = normalizePageTitle(
    (versionResult.rows[0] as { title: string | null }).title ?? '',
  );

  const updateResult = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'edit', tx);
    const result = await executeQuery(
      tx,
      `update pages
       set title_revision = title_revision + case when title is distinct from $1 then 1 else 0 end,
           title = $1,
           title_search = to_tsvector('english', $1),
           updated_at = now()
       where id = $2
       returning id, title`,
      [versionTitle, pageId],
    );
    await executeQuery(tx, 'select pg_notify($1, $2)', [
      'page_renamed',
      JSON.stringify({ pageId }),
    ]);
    return result;
  });

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
