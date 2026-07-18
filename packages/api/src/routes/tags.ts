import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';

const tagsRoute = new Hono();
tagsRoute.use('*', requireAuth);

tagsRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `select c.target_slug as id,
            trim(leading '#' from c.target_slug) as name,
            count(distinct c.source_id) as page_count
     from connections c
     join pages p on p.id = c.source_id
     where c.connection_type = 'tag'
       and p.id in (select page_id from get_accessible_page_ids($1))
       and p.is_deleted = false
     group by c.target_slug
     order by page_count desc, name asc`,
    [user.id],
  );

  return c.json(result.rows);
});

tagsRoute.get('/pages', async (c) => {
  const tagId = c.req.query('tagId');

  if (!tagId) {
    throw new HTTPException(400, { message: 'tagId is required' });
  }

  const user = c.get('user') as { id: string };

  const result = await query(
    `select p.id,
            p.title,
            p.icon,
            case
              when p.parent_id in (select folder_id from get_enumerable_folder_ids($2))
                then p.parent_id
              else null
            end as "parentId"
     from pages p
     join connections c on c.source_id = p.id
     where c.target_slug = $1
       and c.connection_type = 'tag'
       and p.id in (select page_id from get_accessible_page_ids($2))
       and p.is_deleted = false
     order by p.updated_at desc`,
    [tagId.startsWith('#') ? tagId : `#${tagId}`, user.id],
  );

  return c.json(result.rows);
});

export default tagsRoute;
