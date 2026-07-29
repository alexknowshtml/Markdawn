import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { workspaceMemberships, workspaces } from '../db/schema';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { lockWorkspaceEntityMutation } from '../utils/share-access';
import {
  type WsRole,
  assertOrgAdmin,
  assertWsAdmin,
  loadOrgCtx,
  loadWorkspaceCtx,
  slugify,
} from '../utils/org-auth';

// Mounted at /api/orgs — handles /:orgSlug/workspaces/* paths
const workspacesRoute = new Hono();
workspacesRoute.use('*', requireAuth);

// GET /:orgSlug/workspaces
workspacesRoute.get('/:orgSlug/workspaces', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });

  const isAdmin = ctx.isSuper || ctx.orgRole === 'owner' || ctx.orgRole === 'admin';
  const visibilityFilter = isAdmin
    ? sql`TRUE`
    : sql`(w.visibility = 'open' OR wm.user_id IS NOT NULL)`;

  const result = await query<{
    id: string;
    name: string;
    slug: string;
    visibility: string;
    role: string | null;
  }>(
    sql`SELECT w.id, w.name, w.slug, w.visibility, wm.role
        FROM workspaces w
        LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = ${user.id}
        WHERE w.org_id = ${ctx.orgId}
          AND w.archived_at IS NULL
          AND ${visibilityFilter}
        ORDER BY w.name ASC`,
  );
  return c.json(result.rows);
});

// POST /:orgSlug/workspaces
workspacesRoute.post('/:orgSlug/workspaces', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const body = await c.req.json().catch(() => null);
  if (!body?.name || typeof body.name !== 'string') {
    throw new HTTPException(400, { message: 'name is required' });
  }
  const name = body.name.trim();
  const slug = (typeof body.slug === 'string' ? body.slug.trim() : null) || slugify(name);
  const visibility = body.visibility === 'private' ? 'private' : 'open';

  const conflict = await query(
    sql`SELECT id FROM workspaces WHERE org_id = ${ctx.orgId} AND slug = ${slug} AND archived_at IS NULL`,
  );
  if (conflict.rowCount && conflict.rowCount > 0) {
    throw new HTTPException(409, { message: `Slug "${slug}" is already taken in this org` });
  }

  const [ws] = await db
    .insert(workspaces)
    .values({ orgId: ctx.orgId, name, slug, visibility, createdBy: user.id })
    .returning({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      visibility: workspaces.visibility,
    });

  return c.json(ws, 201);
});

// GET /:orgSlug/workspaces/:workspaceSlug
workspacesRoute.get('/:orgSlug/workspaces/:workspaceSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });

  const result = await query<{
    id: string;
    name: string;
    slug: string;
    visibility: string;
    createdAt: string;
  }>(
    sql`SELECT id, name, slug, visibility, created_at AS "createdAt"
        FROM workspaces WHERE id = ${wsCtx.workspaceId}`,
  );
  return c.json({ ...result.rows[0], wsRole: wsCtx.wsRole });
});

// PATCH /:orgSlug/workspaces/:workspaceSlug
workspacesRoute.patch('/:orgSlug/workspaces/:workspaceSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });
  assertWsAdmin(wsCtx, ctx);

  const body = await c.req.json().catch(() => null);
  const current = await query<{ name: string; slug: string; visibility: string }>(
    sql`SELECT name, slug, visibility FROM workspaces WHERE id = ${wsCtx.workspaceId}`,
  );
  const newName = typeof body?.name === 'string' ? body.name.trim() : current.rows[0].name;
  const newSlug = typeof body?.slug === 'string' ? body.slug.trim() : current.rows[0].slug;
  const newVisibility =
    body?.visibility === 'open' || body?.visibility === 'private'
      ? body.visibility
      : current.rows[0].visibility;

  if (newSlug !== current.rows[0].slug) {
    const conflict = await query(
      sql`SELECT id FROM workspaces WHERE org_id = ${ctx.orgId} AND slug = ${newSlug} AND id != ${wsCtx.workspaceId}`,
    );
    if (conflict.rowCount && conflict.rowCount > 0) {
      throw new HTTPException(409, { message: `Slug "${newSlug}" is already taken` });
    }
  }

  await query(
    sql`UPDATE workspaces SET name = ${newName}, slug = ${newSlug}, visibility = ${newVisibility}, updated_at = now()
        WHERE id = ${wsCtx.workspaceId}`,
  );
  return c.json({ ok: true, name: newName, slug: newSlug, visibility: newVisibility });
});

// DELETE /:orgSlug/workspaces/:workspaceSlug — archive
workspacesRoute.delete('/:orgSlug/workspaces/:workspaceSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx) throw new HTTPException(404, { message: 'Workspace not found' });

  await query(
    sql`UPDATE workspaces SET archived_at = now(), updated_at = now() WHERE id = ${wsCtx.workspaceId}`,
  );
  return c.json({ ok: true });
});

// GET /:orgSlug/workspaces/:workspaceSlug/members
workspacesRoute.get('/:orgSlug/workspaces/:workspaceSlug/members', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });

  const result = await query<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
    joinedAt: string;
  }>(
    sql`SELECT u.id, u.name, u.email, u.avatar_url AS "avatarUrl", wm.role, wm.created_at AS "joinedAt"
        FROM workspace_memberships wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ${wsCtx.workspaceId}
        ORDER BY wm.role DESC, u.name ASC`,
  );
  return c.json(result.rows);
});

// POST /:orgSlug/workspaces/:workspaceSlug/members
workspacesRoute.post('/:orgSlug/workspaces/:workspaceSlug/members', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });
  assertWsAdmin(wsCtx, ctx);

  const body = await c.req.json().catch(() => null);
  const { userId: targetId, role } = (body ?? {}) as { userId?: string; role?: string };
  if (!targetId) throw new HTTPException(400, { message: 'userId is required' });
  if (!['admin', 'editor', 'viewer'].includes(role ?? '')) {
    throw new HTTPException(400, { message: 'role must be admin, editor, or viewer' });
  }

  const memberCheck = await query(
    sql`SELECT user_id FROM org_members WHERE org_id = ${ctx.orgId} AND user_id = ${targetId}`,
  );
  if (!memberCheck.rowCount || memberCheck.rowCount === 0) {
    throw new HTTPException(400, { message: 'User must be an org member first' });
  }

  try {
    await db.transaction(async (tx) => {
      await lockWorkspaceEntityMutation(tx, wsCtx.workspaceId);
      await tx
        .insert(workspaceMemberships)
        .values({ workspaceId: wsCtx.workspaceId, userId: targetId, role: role as WsRole });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      throw new HTTPException(409, { message: 'User is already a workspace member' });
    }
    throw err;
  }
  return c.json({ ok: true, userId: targetId, role }, 201);
});

// PATCH /:orgSlug/workspaces/:workspaceSlug/members/:userId/role
workspacesRoute.patch('/:orgSlug/workspaces/:workspaceSlug/members/:userId/role', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });
  assertWsAdmin(wsCtx, ctx);

  const targetId = c.req.param('userId');
  const body = await c.req.json().catch(() => null);
  const role = (body as { role?: string })?.role;
  if (!['admin', 'editor', 'viewer'].includes(role ?? '')) {
    throw new HTTPException(400, { message: 'role must be admin, editor, or viewer' });
  }

  let rowCount = 0;
  await db.transaction(async (tx) => {
    await lockWorkspaceEntityMutation(tx, wsCtx.workspaceId);
    const result = await executeQuery(
      tx,
      sql`UPDATE workspace_memberships SET role = ${role}
          WHERE workspace_id = ${wsCtx.workspaceId} AND user_id = ${targetId}
          RETURNING user_id`,
    );
    rowCount = result.rowCount ?? 0;
  });
  if (rowCount === 0) throw new HTTPException(404, { message: 'Member not found' });
  return c.json({ ok: true, role });
});

// DELETE /:orgSlug/workspaces/:workspaceSlug/members/:userId
workspacesRoute.delete('/:orgSlug/workspaces/:workspaceSlug/members/:userId', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  const wsCtx = await loadWorkspaceCtx(ctx.orgId, c.req.param('workspaceSlug'), user.id, ctx);
  if (!wsCtx || !wsCtx.canAccess) throw new HTTPException(404, { message: 'Workspace not found' });

  const targetId = c.req.param('userId');
  if (targetId !== user.id) assertWsAdmin(wsCtx, ctx);

  let rowCount = 0;
  await db.transaction(async (tx) => {
    await lockWorkspaceEntityMutation(tx, wsCtx.workspaceId);
    const result = await executeQuery(
      tx,
      sql`DELETE FROM workspace_memberships
          WHERE workspace_id = ${wsCtx.workspaceId} AND user_id = ${targetId}
          RETURNING user_id`,
    );
    rowCount = result.rowCount ?? 0;
  });
  if (rowCount === 0) throw new HTTPException(404, { message: 'Member not found' });
  return c.json({ ok: true });
});

export default workspacesRoute;
