import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import {
  ensureCanManageEntity,
  ensureFolderAccess,
  ensurePageAccess,
  parseEntityType,
  parsePermission,
  type ShareEntityType,
  type SharePermission,
} from '../utils/share-access';

type EntityInfo = {
  id: string;
  ownerId?: string | null;
  title: string;
};

type ShareRow = {
  id: string;
  entity_type: ShareEntityType;
  entity_id: string;
  permission: SharePermission;
  token: string | null;
  recipient_user_id: string | null;
  recipient_email: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  shared_by_name: string | null;
  shared_by_email: string | null;
  recipient_name: string | null;
  recipient_avatar_url: string | null;
};

type AccessorRow = {
  share_id: string | null;
  user_id: string;
  name: string | null;
  email: string | null;
  permission: SharePermission;
  source: string;
};

const permissionRank = (permission: SharePermission) => (permission === 'edit' ? 2 : 1);
const slugifyTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildPagePath = (title: string, pageId: string) =>
  `/app/${slugifyTitle(title) || 'page'}-${pageId}`;

const mergeSource = (sources: Set<string>) => {
  const ordered = ['Email', 'Link'].filter((source) => sources.has(source));
  return ordered.join(' + ');
};

const sharesRoute = new Hono();

sharesRoute.use('*', requireAuth);

const normalizeShare = (row: ShareRow) => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  permission: row.permission,
  token: row.token,
  recipientUserId: row.recipient_user_id,
  recipientEmail: row.recipient_email,
  recipientName: row.recipient_name,
  recipientAvatarUrl: row.recipient_avatar_url,
  sharedByName: row.shared_by_name,
  sharedByEmail: row.shared_by_email,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getPageAccessors = async (pageId: string) => {
  const [inviteResult, accessResult] = await Promise.all([
    pool.query(
      `
        select
          s.id as share_id,
          s.recipient_user_id as user_id,
          recipient.name,
          recipient.email,
          s.permission,
          'Email' as source
        from shares s
        join users recipient on recipient.id = s.recipient_user_id
        where s.entity_type = 'page'
          and s.entity_id = $1
          and s.recipient_user_id is not null
          and s.token is null
      `,
      [pageId],
    ),
    pool.query(
      `
        select
          null::uuid as share_id,
          pae.user_id,
          recipient.name,
          recipient.email,
          pae.permission,
          'Link' as source
        from page_access_events pae
        join users recipient on recipient.id = pae.user_id
        where pae.page_id = $1
      `,
      [pageId],
    ),
  ]);

  const accessors = new Map<
    string,
    {
      shareId: string | null;
      userId: string;
      name: string | null;
      email: string | null;
      permission: SharePermission;
      sources: Set<string>;
    }
  >();

  for (const row of [...inviteResult.rows, ...accessResult.rows]) {
    const item = row as AccessorRow;
    const existing = accessors.get(item.user_id);
    if (existing) {
      existing.permission =
        permissionRank(item.permission) > permissionRank(existing.permission)
          ? item.permission
          : existing.permission;
      existing.sources.add(item.source);
      if (!existing.name && item.name) {
        existing.name = item.name;
      }
      if (!existing.email && item.email) {
        existing.email = item.email;
      }
      if (!existing.shareId && item.share_id) {
        existing.shareId = item.share_id;
      }
    } else {
      accessors.set(item.user_id, {
        shareId: item.share_id,
        userId: item.user_id,
        name: item.name,
        email: item.email,
        permission: item.permission,
        sources: new Set([item.source]),
      });
    }
  }

  return Array.from(accessors.values()).map((item) => ({
    shareId: item.shareId,
    userId: item.userId,
    name: item.name,
    email: item.email,
    permission: item.permission,
    source: mergeSource(item.sources),
  }));
};

const resolveEntity = async (
  entityType: ShareEntityType,
  entityId: string,
): Promise<EntityInfo> => {
  if (entityType === 'folder') {
    const result = await pool.query(
      'select id, created_by, name from folders where id = $1 and is_deleted = false',
      [entityId],
    );
    const row = result.rows[0] as
      | { id: string; created_by?: string | null; name: string }
      | undefined;
    if (!row) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }
    return { id: row.id, ownerId: row.created_by ?? null, title: row.name };
  }

  const result = await pool.query(
    'select id, created_by, title from pages where id = $1 and is_deleted = false',
    [entityId],
  );
  const row = result.rows[0] as
    | { id: string; created_by?: string | null; title: string }
    | undefined;
  if (!row) {
    throw new HTTPException(404, { message: 'Page not found' });
  }
  return { id: row.id, ownerId: row.created_by ?? null, title: row.title };
};

sharesRoute.get('/with-me', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await pool.query(
    `
      (
        select
          s.id,
          s.entity_type,
          s.entity_id,
          s.permission,
          s.token,
          s.recipient_user_id,
          s.recipient_email,
          s.created_at,
          s.updated_at,
          owner.name as shared_by_name,
          owner.email as shared_by_email,
          recipient.name as recipient_name,
          recipient.avatar_url as recipient_avatar_url,
          case
            when s.entity_type = 'folder' then f.name
            else p.title
          end as entity_title,
          case
            when s.entity_type = 'page' then p.icon
            when s.entity_type = 'folder' then f.icon
            else null
          end as entity_icon
        from shares s
        left join pages p on p.id = s.entity_id and s.entity_type = 'page'
        left join folders f on f.id = s.entity_id and s.entity_type = 'folder'
        left join users owner on owner.id = s.shared_by
        left join users recipient on recipient.id = s.recipient_user_id
        where s.recipient_user_id = $1
      )
      UNION
      (
        select
          pae.id,
          'page' as entity_type,
          pae.page_id as entity_id,
          pae.permission,
          null as token,
          pae.user_id as recipient_user_id,
          null as recipient_email,
          pae.first_seen_at as created_at,
          pae.last_seen_at as updated_at,
          null as shared_by_name,
          null as shared_by_email,
          u.name as recipient_name,
          u.avatar_url as recipient_avatar_url,
          p.title as entity_title,
          p.icon as entity_icon
        from page_access_events pae
        join pages p on p.id = pae.page_id
        join users u on u.id = pae.user_id
        where pae.user_id = $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'page' and s.entity_id = pae.page_id
              and s.recipient_user_id = $1 and s.token is null
          )
      )
      order by created_at desc nulls last
    `,
    [user.id],
  );

  return c.json(
    result.rows.map((row) => {
      const item = row as ShareRow & {
        entity_title: string | null;
        entity_icon: string | null;
      };
      return {
        ...normalizeShare(item),
        title: item.entity_title ?? 'Untitled',
        icon: item.entity_icon,
      };
    }),
  );
});

sharesRoute.get('/entity/:entityType/:entityId', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);
  // Ensure the caller has at least view access to the entity
  if (entityType === 'page') {
    await ensurePageAccess(entity.id, user.id);
  } else {
    await ensureFolderAccess(entity.id, user.id);
  }

  const result = await pool.query(
    `
      select
        s.id,
        s.entity_type,
        s.entity_id,
        s.permission,
        s.token,
        s.recipient_user_id,
        s.recipient_email,
        s.created_at,
        s.updated_at,
        owner.name as shared_by_name,
        owner.email as shared_by_email,
        recipient.name as recipient_name,
        recipient.avatar_url as recipient_avatar_url
      from shares s
      left join users owner on owner.id = s.shared_by
      left join users recipient on recipient.id = s.recipient_user_id
      where s.entity_type = $1 and s.entity_id = $2
      order by s.token nulls last, s.created_at asc
    `,
    [entityType, entityId],
  );

  const shares = (result.rows as ShareRow[]).map(normalizeShare);
  const linkShare = shares.find((share) => share.token);
  const accessors = entityType === 'page' ? await getPageAccessors(entityId) : [];
  return c.json({
    entity: {
      type: entityType,
      id: entity.id,
      title: entity.title,
    },
    link: linkShare
      ? {
          permission: linkShare.permission,
          token: linkShare.token,
          url: entityType === 'page' ? buildPagePath(entity.title, entity.id) : null,
        }
      : { permission: 'private', token: null, url: null },
    invites: shares.filter((share) => !share.token),
    accessors,
  });
});

sharesRoute.patch('/entity/:entityType/:entityId/link', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);
  await ensureCanManageEntity(entityType === 'page' ? 'page' : 'folder', entity.id, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const permission = (body as { permission?: unknown }).permission;

  if (permission === 'private') {
    await pool.query(
      'delete from shares where entity_type = $1 and entity_id = $2 and token is not null',
      [entityType, entityId],
    );
    if (entityType === 'page') {
      await pool.query(
        'update pages set is_public = false, public_token = null, updated_at = now() where id = $1',
        [entityId],
      );
    }
    return c.json({ permission: 'private', token: null, url: null });
  }

  const nextPermission = parsePermission(permission);
  const existing = await pool.query(
    'select id, token from shares where entity_type = $1 and entity_id = $2 and token is not null limit 1',
    [entityType, entityId],
  );
  const existingRow = existing.rows[0] as { id: string; token: string } | undefined;
  const token = existingRow?.token ?? crypto.randomUUID();

  if (existingRow) {
    await pool.query('update shares set permission = $1, updated_at = now() where id = $2', [
      nextPermission,
      existingRow.id,
    ]);
  } else {
    await pool.query(
      'insert into shares (entity_type, entity_id, shared_by, permission, token) values ($1, $2, $3, $4, $5)',
      [entityType, entityId, user.id, nextPermission, token],
    );
  }

  if (entityType === 'page') {
    await pool.query(
      'update pages set is_public = true, public_token = $1, updated_at = now() where id = $2',
      [token, entityId],
    );
  }

  return c.json({
    permission: nextPermission,
    token,
    url: entityType === 'page' ? buildPagePath(entity.title, entity.id) : null,
  });
});

sharesRoute.post('/entity/:entityType/:entityId/invite', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);
  await ensureCanManageEntity(entityType === 'page' ? 'page' : 'folder', entity.id, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const { email, permission } = body as { email?: unknown; permission?: unknown };
  if (typeof email !== 'string' || email.trim().length === 0) {
    throw new HTTPException(400, { message: 'Email is required' });
  }

  const userResult = await pool.query(
    'select id, email from users where lower(email) = lower($1) limit 1',
    [email.trim()],
  );
  const recipient = userResult.rows[0] as { id: string; email: string } | undefined;
  if (!recipient) {
    throw new HTTPException(404, { message: 'User not found' });
  }
  if (recipient.id === user.id) {
    throw new HTTPException(400, { message: 'Cannot share with yourself' });
  }

  const nextPermission = parsePermission(permission);
  const existing = await pool.query(
    'select id from shares where entity_type = $1 and entity_id = $2 and recipient_user_id = $3 and token is null limit 1',
    [entityType, entityId, recipient.id],
  );
  const existingRow = existing.rows[0] as { id: string } | undefined;

  if (existingRow) {
    await pool.query('update shares set permission = $1, updated_at = now() where id = $2', [
      nextPermission,
      existingRow.id,
    ]);
  } else {
    await pool.query(
      `
        insert into shares (
          entity_type,
          entity_id,
          shared_by,
          recipient_user_id,
          recipient_email,
          permission
        )
        values ($1, $2, $3, $4, $5, $6)
      `,
      [entityType, entityId, user.id, recipient.id, recipient.email, nextPermission],
    );
  }

  return c.json({ ok: true });
});

sharesRoute.delete('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user') as { id: string };
  const result = await pool.query(
    'select entity_type, entity_id from shares where id = $1 limit 1',
    [shareId],
  );
  const row = result.rows[0] as { entity_type?: ShareEntityType; entity_id?: string } | undefined;
  if (!row?.entity_type || !row.entity_id) {
    throw new HTTPException(404, { message: 'Share not found' });
  }
  await ensureCanManageEntity(
    row.entity_type === 'page' ? 'page' : 'folder',
    row.entity_id,
    user.id,
  );
  await pool.query('delete from shares where id = $1', [shareId]);
  return c.json({ ok: true });
});

export default sharesRoute;
