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
         and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = (
           select coalesce(get_root_folder_owner(target.parent_id), target.created_by)
           from pages target where target.id = $1 and target.is_deleted = false
         )
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
      `select c.id, accessible_target.id as "targetPageId",
              case
                when accessible_target.id is not null then accessible_target.title
                when known_target.id is not null then 'Restricted page'
                else 'Link unavailable'
              end as "targetTitle",
              case
                when accessible_target.id is not null then c.link_text
                when known_target.id is not null then 'Restricted page'
                else 'Link unavailable'
              end as "linkText",
              c.connection_type as "linkType",
              case
                when accessible_target.id is not null then 'accessible'
                when known_target.id is not null then 'restricted'
                else 'unavailable'
              end as "targetState",
              accessible_target.title as "targetPageTitle",
              accessible_target.icon as "targetPageIcon"
       from connections c
       join pages source on source.id = c.source_id and source.is_deleted = false
       left join pages known_target on known_target.id = c.target_id
         and known_target.is_deleted = false
         and coalesce(get_root_folder_owner(known_target.parent_id), known_target.created_by) =
             coalesce(get_root_folder_owner(source.parent_id), source.created_by)
       left join pages accessible_target on accessible_target.id = known_target.id
         and exists (
           select 1
           from get_effective_page_permission(accessible_target.id, $2) access
           where access.permission is not null
         )
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
