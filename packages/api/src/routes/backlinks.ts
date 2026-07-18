import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { ensurePageAccess, lockEntityAccess } from '../utils/share-access';

const backlinksRoute = new Hono();
backlinksRoute.use('*', requireAuth);

backlinksRoute.get('/', async (c) => {
  const pageId = c.req.query('pageId');
  if (!pageId) {
    throw new HTTPException(400, { message: 'pageId is required' });
  }

  const user = c.get('user') as { id: string };
  const result = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    return executeQuery(
      tx,
      `select c.id, c.source_id as "sourcePageId", c.link_text as "linkText",
              c.connection_type as "linkType", c.updated_at as "createdAt",
              p.title as "sourceTitle", p.icon as "sourceIcon"
       from connections c
       join pages p on p.id = c.source_id
       where c.target_type = 'page'
         and c.target_id = $1
         and c.connection_type in ('wikilink', 'heading', 'embed')
         and p.is_deleted = false
         and p.id in (select page_id from get_accessible_page_ids($2))
       order by c.updated_at desc`,
      [pageId, user.id],
    );
  });

  return c.json(result.rows);
});

backlinksRoute.get('/outgoing', async (c) => {
  const pageId = c.req.query('pageId');
  if (!pageId) {
    throw new HTTPException(400, { message: 'pageId is required' });
  }

  const user = c.get('user') as { id: string };
  const result = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    return executeQuery(
      tx,
      `select c.id, p.id as "targetPageId",
              case
                when p.id is not null then c.target_label
                else c.link_text
              end as "targetTitle",
              c.link_text as "linkText", c.connection_type as "linkType",
              p.title as "targetPageTitle", p.icon as "targetPageIcon"
       from connections c
       left join pages p on p.id = c.target_id
         and p.is_deleted = false
         and p.id in (select page_id from get_accessible_page_ids($2))
       where c.source_id = $1
         and c.target_type = 'page'
         and c.connection_type in ('wikilink', 'heading', 'embed')
       order by c.updated_at desc`,
      [pageId, user.id],
    );
  });

  return c.json(result.rows);
});

export default backlinksRoute;
