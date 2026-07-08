import type { ShareEntityType } from '@markdawn/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { ensureFolderAccess, ensurePageAccess } from '../utils/share-access';

type FavoriteRow = {
  entity_type: ShareEntityType;
  entity_id: string;
  title: string;
  icon: string | null;
  owner_id: string | null;
  created_at: Date | null;
};

const favoritesRoute = new Hono();

favoritesRoute.use('*', requireAuth);

const parseEntityType = (value: unknown): ShareEntityType => {
  if (value === 'page' || value === 'folder') {
    return value;
  }
  throw new HTTPException(400, { message: 'Invalid entityType' });
};

const ensureEntityAccess = async (
  entityType: ShareEntityType,
  entityId: string,
  userId: string,
) => {
  if (entityType === 'page') {
    await ensurePageAccess(entityId, userId);
    return;
  }
  await ensureFolderAccess(entityId, userId);
};

favoritesRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `select
       uf.entity_type,
       uf.entity_id,
       case when uf.entity_type = 'folder' then f.name else p.title end as title,
       case when uf.entity_type = 'folder' then f.icon else p.icon end as icon,
       case
         when uf.entity_type = 'folder' then get_root_folder_owner(f.id)
         else coalesce(get_root_folder_owner(p.parent_id), p.created_by)
       end as owner_id,
       uf.created_at
     from user_favorites uf
     left join pages p on p.id = uf.entity_id and uf.entity_type = 'page' and p.is_deleted = false
     left join folders f on f.id = uf.entity_id and uf.entity_type = 'folder' and f.is_deleted = false
     where uf.user_id = $1
       and ((uf.entity_type = 'page' and p.id is not null) or (uf.entity_type = 'folder' and f.id is not null))
       and case
         when uf.entity_type = 'folder' then exists (
           select 1 from get_effective_folder_permission(f.id, $1) access where access.permission is not null
         )
         else exists (
           select 1 from get_effective_page_permission(p.id, $1) access where access.permission is not null
         )
       end
     order by uf.created_at desc nulls last`,
    [user.id],
  );

  const favorites = (result.rows as FavoriteRow[]).map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    ...(row.entity_type === 'page' ? { pageId: row.entity_id } : {}),
    title: row.title,
    icon: row.icon,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  }));

  return c.json({ favorites });
});

favoritesRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const raw = body as { entityType?: unknown; entityId?: unknown; pageId?: unknown };
  const entityType = raw.entityType === undefined ? 'page' : parseEntityType(raw.entityType);
  const entityId =
    typeof raw.entityId === 'string'
      ? raw.entityId
      : entityType === 'page' && typeof raw.pageId === 'string'
        ? raw.pageId
        : null;

  if (!entityId) {
    throw new HTTPException(400, { message: 'entityId is required' });
  }

  const existsResult = await query(
    entityType === 'page'
      ? 'select id, is_deleted from pages where id = $1 limit 1'
      : 'select id, is_deleted from folders where id = $1 limit 1',
    [entityId],
  );
  const entity = existsResult.rows[0] as { id: string; is_deleted: boolean | null } | undefined;
  if (!entity || entity.is_deleted) {
    throw new HTTPException(404, {
      message: `${entityType === 'page' ? 'Page' : 'Folder'} not found`,
    });
  }

  const user = c.get('user') as { id: string };
  await ensureEntityAccess(entityType, entityId, user.id);

  const insertResult = await query(
    'insert into user_favorites (user_id, entity_type, entity_id) values ($1, $2, $3) on conflict (user_id, entity_type, entity_id) do nothing returning id',
    [user.id, entityType, entityId],
  );

  if (insertResult.rowCount === 0) {
    return c.json({ ok: true });
  }

  return c.json({ ok: true }, 201);
});

favoritesRoute.delete('/:entityType/:entityId', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };

  await ensureEntityAccess(entityType, entityId, user.id);
  await query(
    'delete from user_favorites where user_id = $1 and entity_type = $2 and entity_id = $3',
    [user.id, entityType, entityId],
  );

  return c.json({ deleted: true });
});

favoritesRoute.delete('/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const pageResult = await query('select id from pages where id = $1 limit 1', [pageId]);
  if (!pageResult.rows[0]) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  await query(
    'delete from user_favorites where user_id = $1 and entity_type = $2 and entity_id = $3',
    [user.id, 'page', pageId],
  );

  return c.json({ deleted: true });
});

export default favoritesRoute;
