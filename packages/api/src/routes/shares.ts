import { deriveCapabilities } from '@markdawn/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import {
  ensureCanAdminEntity,
  ensureFolderAccess,
  ensurePageAccess,
  parseEntityType,
  parsePermission,
  type ShareEntityType,
  type SharePermission,
} from '../utils/share-access';
import { notifyShareGrant, notifyShareRevoke, notifyShareUpdate } from '../utils/share-notify';

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
  avatar_url: string | null;
  permission: SharePermission;
  source: string;
};

const slugifyTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildPagePath = (title: string, pageId: string) =>
  `/app/${slugifyTitle(title) || 'page'}-${pageId}`;

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
  const ownerResult = await pool.query(
    `
      select p.created_by as user_id, u.name, u.email, coalesce(u.avatar_url, u.image) as avatar_url
      from pages p
      join users u on u.id = p.created_by
      where p.id = $1 and p.is_deleted = false
    `,
    [pageId],
  );
  const ownerRow = ownerResult.rows[0] as
    | { user_id: string; name: string | null; email: string | null; avatar_url: string | null }
    | undefined;

  const [inviteResult, linkResult] = await Promise.all([
    pool.query(
      `
        select
          s.id as share_id,
          s.recipient_user_id as user_id,
          recipient.name,
          recipient.email,
          coalesce(recipient.avatar_url, recipient.image) as avatar_url,
          s.permission,
          'Email' as source
        from shares s
        join users recipient on recipient.id = s.recipient_user_id
        where s.entity_type = 'page'
          and s.entity_id = $1
          and s.recipient_user_id is not null
          and s.token is null
          and s.recipient_user_id != $2
      `,
      [pageId, ownerRow?.user_id ?? ''],
    ),
    pool.query(
      "select permission from shares where entity_type = 'page' and entity_id = $1 and token is not null limit 1",
      [pageId],
    ),
  ]);

  const linkPermission = linkResult.rows[0]?.permission as SharePermission | undefined;

  const rank = (p: SharePermission) => (p === 'admin' ? 3 : p === 'edit' ? 2 : 1);

  const result: Array<{
    shareId: string | null;
    userId: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    permission: SharePermission;
    source: string;
    isOwner: boolean;
  }> = [];

  if (ownerRow) {
    result.push({
      shareId: null,
      userId: ownerRow.user_id,
      name: ownerRow.name,
      email: ownerRow.email,
      avatarUrl: ownerRow.avatar_url,
      permission: 'edit',
      source: 'owner',
      isOwner: true,
    });
  }

  for (const row of inviteResult.rows) {
    const item = row as AccessorRow & { avatar_url: string | null };
    const effectivePermission =
      linkPermission && rank(linkPermission) > rank(item.permission)
        ? linkPermission
        : item.permission;
    result.push({
      shareId: item.share_id,
      userId: item.user_id,
      name: item.name,
      email: item.email,
      avatarUrl: item.avatar_url,
      permission: effectivePermission,
      source: 'Email',
      isOwner: false,
    });
  }

  return result;
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

sharesRoute.get('/pages/collaborators', async (c) => {
  const pageIdsParam = c.req.query('pageIds');
  if (!pageIdsParam) {
    return c.json({ error: 'pageIds query parameter is required' }, 400);
  }

  const pageIds = pageIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (pageIds.length === 0) {
    return c.json({});
  }

  const limitedPageIds = pageIds.slice(0, 50);
  const results = await Promise.all(limitedPageIds.map((id) => getPageAccessors(id)));
  const collaborators = Object.fromEntries(limitedPageIds.map((id, i) => [id, results[i]]));

  return c.json(collaborators);
});

sharesRoute.get('/entity/:entityType/:entityId', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);
  // Determine the caller's effective permission — ensures access and captures
  // the highest permission across invites, folder inheritance, and link shares.
  let userPermission: SharePermission | null = null;
  if (entityType === 'page') {
    const access = await ensurePageAccess(entity.id, user.id);
    userPermission = access.permission;
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

  const permissionDetails: Array<{
    source: string;
    permission: string;
    grantedByName?: string | null;
    grantedByEmail?: string | null;
    folderName?: string | null;
    folderId?: string | null;
  }> = [];
  if (entityType === 'page') {
    // Fetch each permission source separately to avoid parameter type inference issues
    const inviteRows = await pool.query(
      `SELECT permission FROM shares
       WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2
         AND token IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
      [entityId, user.id],
    );
    inviteRows.rows.forEach((row: { permission: string }) => {
      permissionDetails.push({ source: 'invite', permission: row.permission });
    });

    const folderRows = await pool.query(
      `WITH RECURSIVE fa AS (
         SELECT f.id, f.parent_id, f.name
         FROM pages p JOIN folders f ON f.id = p.parent_id WHERE p.id = $1
         UNION ALL
         SELECT parent.id, parent.parent_id, parent.name
         FROM folders parent JOIN fa child ON child.parent_id = parent.id
       )
       SELECT s.permission, u.name AS granted_by_name, u.email AS granted_by_email,
              fa.name AS folder_name, fa.id::text AS folder_id
       FROM shares s
       JOIN fa ON fa.id = s.entity_id
       LEFT JOIN users u ON u.id = s.shared_by
       WHERE s.entity_type = 'folder' AND s.recipient_user_id = $2
         AND (s.expires_at IS NULL OR s.expires_at > NOW())`,
      [entityId, user.id],
    );
    folderRows.rows.forEach((row) => {
      permissionDetails.push({
        source: 'folder',
        permission: row.permission,
        grantedByName: row.granted_by_name ?? null,
        grantedByEmail: row.granted_by_email ?? null,
        folderName: row.folder_name ?? null,
        folderId: row.folder_id ?? null,
      });
    });

    const linkRows = await pool.query(
      `SELECT permission FROM shares
       WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND EXISTS (SELECT 1 FROM pages WHERE id = $1 AND is_public = true)`,
      [entityId],
    );
    linkRows.rows.forEach((row: { permission: string }) => {
      permissionDetails.push({ source: 'link', permission: row.permission });
    });

    const workspaceRows = await pool.query(
      `SELECT CASE WHEN wm.role = 'admin' THEN 'admin' ELSE 'edit' END AS permission
       FROM workspace_members wm
       JOIN pages p ON p.id = $1
       WHERE wm.workspace_owner_id = p.created_by AND wm.member_id = $2
         AND NOT EXISTS (
           WITH RECURSIVE fa AS (
             SELECT f.id, f.parent_id, f.is_access_restricted
             FROM pages p2 JOIN folders f ON f.id = p2.parent_id WHERE p2.id = $1
             UNION ALL
             SELECT parent.id, parent.parent_id, parent.is_access_restricted
             FROM folders parent JOIN fa child ON child.parent_id = parent.id
           )
           SELECT 1 FROM fa WHERE is_access_restricted = true
         )`,
      [entityId, user.id],
    );
    workspaceRows.rows.forEach((row: { permission: string }) => {
      permissionDetails.push({ source: 'workspace', permission: row.permission });
    });
  }

  const inheritedAccessors: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    permission: string;
    source: string;
    folderName?: string | null;
    folderId?: string | null;
  }> = [];
  if (entityType === 'page' && accessors.length > 0) {
    const existingUserIds = new Set(accessors.map((a) => a.userId));
    const inheritedResult = await pool.query(
      `SELECT wm.member_id, u.name, u.email,
              CASE WHEN wm.role = 'admin' THEN 'admin' ELSE 'edit' END AS permission
       FROM workspace_members wm
       JOIN users u ON u.id = wm.member_id
       WHERE wm.workspace_owner_id = $1`,
      [user.id],
    );
    for (const row of inheritedResult.rows) {
      if (!existingUserIds.has(row.member_id)) {
        inheritedAccessors.push({
          userId: row.member_id,
          name: row.name,
          email: row.email,
          permission: row.permission,
          source: 'workspace',
        });
      }
    }
  }

  return c.json({
    entity: {
      type: entityType,
      id: entity.id,
      title: entity.title,
      ownerId: entity.ownerId ?? null,
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
    userPermission,
    capabilities: deriveCapabilities(userPermission),
    permissionDetails,
    inheritedAccessors,
  });
});

sharesRoute.patch('/entity/:entityType/:entityId/link', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);
  await ensureCanAdminEntity(entityType === 'page' ? 'page' : 'folder', entity.id, user.id);

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
      await pool.query("delete from page_access_events where page_id = $1 and source = 'link'", [
        entityId,
      ]);
    }

    // Notify collab server to disconnect anonymous users
    if (entityType === 'page') {
      await notifyShareRevoke({ entityType, entityId });
    }

    return c.json({ permission: 'private', token: null, url: null });
  }

  const nextPermission = parsePermission(permission);
  const expiresAt = (body as { expiresAt?: string | null }).expiresAt ?? null;
  const existing = await pool.query(
    'select id, token from shares where entity_type = $1 and entity_id = $2 and token is not null limit 1',
    [entityType, entityId],
  );
  const existingRow = existing.rows[0] as { id: string; token: string } | undefined;
  const token = existingRow?.token ?? crypto.randomUUID();

  if (existingRow) {
    await pool.query(
      'update shares set permission = $1, expires_at = $2, updated_at = now() where id = $3',
      [nextPermission, expiresAt, existingRow.id],
    );
  } else {
    await pool.query(
      'insert into shares (entity_type, entity_id, shared_by, permission, token, expires_at) values ($1, $2, $3, $4, $5, $6)',
      [entityType, entityId, user.id, nextPermission, token, expiresAt],
    );
  }

  if (entityType === 'page') {
    await pool.query(
      'update pages set is_public = true, public_token = $1, updated_at = now() where id = $2',
      [token, entityId],
    );
    await pool.query(
      'update page_access_events set permission = $1 where page_id = $2 and source = $3',
      [nextPermission, entityId, 'link'],
    );
  }

  // Notify collab server of permission change (e.g., edit → view downgrade)
  if (entityType === 'page') {
    await notifyShareUpdate({ entityType, entityId, permission: nextPermission });
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
  await ensureCanAdminEntity(entityType === 'page' ? 'page' : 'folder', entity.id, user.id);

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

  if (entity.ownerId && recipient.id === entity.ownerId) {
    throw new HTTPException(400, { message: 'Owner already has full access' });
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

  // Notify collab server to grant/update access for the recipient in realtime
  if (entityType === 'page') {
    await notifyShareGrant({
      entityType,
      entityId,
      permission: nextPermission,
      targetUserId: recipient.id,
    });
  }

  return c.json({ ok: true });
});

sharesRoute.patch('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user') as { id: string };

  const result = await pool.query(
    'select entity_type, entity_id, recipient_user_id from shares where id = $1 limit 1',
    [shareId],
  );
  const row = result.rows[0] as
    | { entity_type?: ShareEntityType; entity_id?: string; recipient_user_id?: string }
    | undefined;
  if (!row?.entity_type || !row.entity_id) {
    throw new HTTPException(404, { message: 'Share not found' });
  }

  await ensureCanAdminEntity(
    row.entity_type === 'page' ? 'page' : 'folder',
    row.entity_id,
    user.id,
  );

  // Admins cannot change other admins' permissions — only the owner can
  const targetResult = await pool.query('select permission from shares where id = $1 limit 1', [
    shareId,
  ]);
  const targetRow = targetResult.rows[0] as { permission?: SharePermission } | undefined;
  if (targetRow?.permission === 'admin') {
    const entity = await resolveEntity(row.entity_type as ShareEntityType, row.entity_id);
    if (entity.ownerId !== user.id) {
      throw new HTTPException(403, { message: "Only the owner can change an admin's permission" });
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const permission = (body as { permission?: unknown }).permission;
  const nextPermission = parsePermission(permission);

  await pool.query('update shares set permission = $1, updated_at = now() where id = $2', [
    nextPermission,
    shareId,
  ]);

  if (row.entity_type === 'page') {
    await notifyShareUpdate({
      entityType: 'page',
      entityId: row.entity_id,
      permission: nextPermission,
      ...(row.recipient_user_id ? { targetUserId: row.recipient_user_id } : {}),
    });
  }

  return c.json({ ok: true });
});

sharesRoute.delete('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user') as { id: string };
  const result = await pool.query(
    'select entity_type, entity_id, recipient_user_id from shares where id = $1 limit 1',
    [shareId],
  );
  const row = result.rows[0] as
    | { entity_type?: ShareEntityType; entity_id?: string; recipient_user_id?: string }
    | undefined;
  if (!row?.entity_type || !row.entity_id) {
    throw new HTTPException(404, { message: 'Share not found' });
  }

  const isSelfRemoval = row.recipient_user_id === user.id;
  if (!isSelfRemoval) {
    await ensureCanAdminEntity(
      row.entity_type === 'page' ? 'page' : 'folder',
      row.entity_id,
      user.id,
    );
  }

  await pool.query('delete from shares where id = $1', [shareId]);

  if (row.entity_type === 'page' && row.recipient_user_id) {
    await pool.query('delete from page_access_events where page_id = $1 and user_id = $2', [
      row.entity_id,
      row.recipient_user_id,
    ]);
  }

  // Notify collab server to revoke access in realtime
  if (row.entity_type === 'page') {
    if (row.recipient_user_id) {
      await notifyShareRevoke({
        entityType: 'page',
        entityId: row.entity_id,
        targetUserId: row.recipient_user_id,
      });
    } else {
      await notifyShareRevoke({ entityType: 'page', entityId: row.entity_id });
    }
  }

  return c.json({ ok: true });
});

export default sharesRoute;
