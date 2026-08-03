import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { inviteTokens, orgMembers, orgs } from '../db/schema';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import {
  type OrgRole,
  assertOrgAdmin,
  assertOrgOwner,
  loadOrgCtx,
  slugify,
} from '../utils/org-auth';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

const orgsRoute = new Hono();
orgsRoute.use('*', requireAuth);

// GET / — list orgs for caller
orgsRoute.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await query<{ id: string; name: string; slug: string; role: string }>(
    sql`SELECT o.id, o.name, o.slug, om.role
        FROM org_members om
        JOIN orgs o ON o.id = om.org_id
        WHERE om.user_id = ${user.id} AND o.archived_at IS NULL
        ORDER BY o.name ASC`,
  );
  return c.json(result.rows);
});

// POST / — create org (super_admin only)
orgsRoute.post('/', async (c) => {
  const user = c.get('user') as { id: string };
  const superCheck = await query<{ systemRole: string | null }>(
    sql`SELECT system_role AS "systemRole" FROM users WHERE id = ${user.id}`,
  );
  if (superCheck.rows[0]?.systemRole !== 'super_admin') {
    throw new HTTPException(403, { message: 'Super admin access required' });
  }
  const body = await c.req.json().catch(() => null);
  if (!body?.name || typeof body.name !== 'string') {
    throw new HTTPException(400, { message: 'name is required' });
  }
  const name = body.name.trim();
  const slug = (typeof body.slug === 'string' ? body.slug.trim() : null) || slugify(name);

  const existing = await query(sql`SELECT id FROM orgs WHERE slug = ${slug}`);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HTTPException(409, { message: `Slug "${slug}" is already taken` });
  }

  const [org] = await db
    .insert(orgs)
    .values({ name, slug })
    .returning({ id: orgs.id, name: orgs.name, slug: orgs.slug });

  if (typeof body.ownerEmail === 'string') {
    const ownerRow = await query<{ id: string }>(
      sql`SELECT id FROM users WHERE lower(email) = lower(${body.ownerEmail}) LIMIT 1`,
    );
    if (ownerRow.rows[0]) {
      await db
        .insert(orgMembers)
        .values({ orgId: org.id, userId: ownerRow.rows[0].id, role: 'owner' });
    }
  }

  return c.json(org, 201);
});

// GET /mine — orgs + accessible workspaces for the current user
orgsRoute.get('/mine', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await query<{
    orgId: string;
    orgName: string;
    orgSlug: string;
    orgRole: string;
    wsId: string | null;
    wsName: string | null;
    wsSlug: string | null;
    wsRole: string | null;
  }>(
    sql`SELECT o.id AS "orgId", o.name AS "orgName", o.slug AS "orgSlug", om.role AS "orgRole",
               w.id AS "wsId", w.name AS "wsName", w.slug AS "wsSlug", wm.role AS "wsRole"
        FROM org_members om
        JOIN orgs o ON o.id = om.org_id AND o.archived_at IS NULL
        LEFT JOIN workspaces w ON w.org_id = o.id AND w.archived_at IS NULL
          AND (w.visibility = 'open' OR EXISTS (
            SELECT 1 FROM workspace_memberships wm2
            WHERE wm2.workspace_id = w.id AND wm2.user_id = ${user.id}
          ))
        LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = ${user.id}
        WHERE om.user_id = ${user.id}
        ORDER BY o.name ASC, w.name ASC`,
  );

  // Group flat rows into org → workspaces tree
  const orgsMap = new Map<string, {
    id: string; name: string; slug: string; role: string;
    workspaces: { id: string; name: string; slug: string; role: string | null }[];
  }>();
  for (const row of result.rows) {
    if (!orgsMap.has(row.orgId)) {
      orgsMap.set(row.orgId, { id: row.orgId, name: row.orgName, slug: row.orgSlug, role: row.orgRole, workspaces: [] });
    }
    if (row.wsId && row.wsName && row.wsSlug) {
      orgsMap.get(row.orgId)!.workspaces.push({ id: row.wsId, name: row.wsName, slug: row.wsSlug, role: row.wsRole });
    }
  }
  return c.json([...orgsMap.values()]);
});

// GET /:orgSlug
orgsRoute.get('/:orgSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });

  const result = await query<{ id: string; name: string; slug: string; createdAt: string }>(
    sql`SELECT id, name, slug, created_at AS "createdAt" FROM orgs WHERE id = ${ctx.orgId}`,
  );
  return c.json({ ...result.rows[0], role: ctx.orgRole });
});

// PATCH /:orgSlug — update name or slug
orgsRoute.patch('/:orgSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Invalid body' });

  const current = await query<{ name: string; slug: string }>(
    sql`SELECT name, slug FROM orgs WHERE id = ${ctx.orgId}`,
  );
  const newName = typeof body.name === 'string' ? body.name.trim() : current.rows[0].name;
  const newSlug = typeof body.slug === 'string' ? body.slug.trim() : current.rows[0].slug;

  if (newSlug !== current.rows[0].slug) {
    const conflict = await query(
      sql`SELECT id FROM orgs WHERE slug = ${newSlug} AND id != ${ctx.orgId}`,
    );
    if (conflict.rowCount && conflict.rowCount > 0) {
      throw new HTTPException(409, { message: `Slug "${newSlug}" is already taken` });
    }
  }

  await query(
    sql`UPDATE orgs SET name = ${newName}, slug = ${newSlug}, updated_at = now() WHERE id = ${ctx.orgId}`,
  );
  return c.json({ ok: true, name: newName, slug: newSlug });
});

// DELETE /:orgSlug — soft delete (archive)
orgsRoute.delete('/:orgSlug', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgOwner(ctx);
  await query(
    sql`UPDATE orgs SET archived_at = now(), updated_at = now() WHERE id = ${ctx.orgId}`,
  );
  return c.json({ ok: true });
});

// GET /:orgSlug/members
orgsRoute.get('/:orgSlug/members', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });

  const result = await query<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
    joinedAt: string;
  }>(
    sql`SELECT u.id, u.name, u.email, u.avatar_url AS "avatarUrl", om.role, om.created_at AS "joinedAt"
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = ${ctx.orgId}
        ORDER BY om.role DESC, u.name ASC`,
  );
  return c.json(result.rows);
});

// POST /:orgSlug/members — add existing user directly
orgsRoute.post('/:orgSlug/members', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const body = await c.req.json().catch(() => null);
  const { email, role } = (body ?? {}) as { email?: string; role?: string };
  if (!email || typeof email !== 'string') throw new HTTPException(400, { message: 'email is required' });
  if (!['owner', 'admin', 'member'].includes(role ?? '')) {
    throw new HTTPException(400, { message: 'role must be owner, admin, or member' });
  }
  if (role === 'owner' && !ctx.isSuper) {
    throw new HTTPException(403, { message: 'Only super admins can assign owner role' });
  }

  const targetRow = await query<{ id: string; name: string }>(
    sql`SELECT id, name FROM users WHERE lower(email) = lower(${email.trim()}) LIMIT 1`,
  );
  if (!targetRow.rows[0]) throw new HTTPException(404, { message: 'User not found' });
  const target = targetRow.rows[0];

  try {
    await db
      .insert(orgMembers)
      .values({ orgId: ctx.orgId, userId: target.id, role: role as OrgRole });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      throw new HTTPException(409, { message: 'User is already a member' });
    }
    throw err;
  }
  return c.json({ ok: true, userId: target.id, name: target.name, role }, 201);
});

// PATCH /:orgSlug/members/:userId/role
orgsRoute.patch('/:orgSlug/members/:userId/role', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const targetId = c.req.param('userId');
  const body = await c.req.json().catch(() => null);
  const role = (body as { role?: string })?.role;
  if (!['admin', 'member'].includes(role ?? '')) {
    throw new HTTPException(400, { message: 'role must be admin or member' });
  }

  await db.transaction(async (tx) => {
    const membersResult = await executeQuery<{ user_id: string; role: string }>(
      tx,
      sql`SELECT user_id, role FROM org_members WHERE org_id = ${ctx.orgId} FOR UPDATE`,
    );
    const members = membersResult.rows;
    const target = members.find((m) => m.user_id === targetId);
    if (!target) throw new HTTPException(404, { message: 'Member not found' });

    if (target.role === 'owner') {
      const ownerCount = members.filter((m) => m.role === 'owner').length;
      if (ownerCount === 1) {
        throw new HTTPException(400, { message: 'Cannot demote the last owner of an org' });
      }
    }

    await executeQuery(
      tx,
      sql`UPDATE org_members SET role = ${role} WHERE org_id = ${ctx.orgId} AND user_id = ${targetId}`,
    );
  });
  return c.json({ ok: true, role });
});

// DELETE /:orgSlug/members/:userId
orgsRoute.delete('/:orgSlug/members/:userId', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });

  const targetId = c.req.param('userId');
  if (targetId !== user.id) assertOrgAdmin(ctx);

  await db.transaction(async (tx) => {
    const membersResult = await executeQuery<{ user_id: string; role: string }>(
      tx,
      sql`SELECT user_id, role FROM org_members WHERE org_id = ${ctx.orgId} FOR UPDATE`,
    );
    const members = membersResult.rows;
    const target = members.find((m) => m.user_id === targetId);
    if (!target) throw new HTTPException(404, { message: 'Member not found' });

    if (target.role === 'owner') {
      const ownerCount = members.filter((m) => m.role === 'owner').length;
      if (ownerCount === 1) {
        throw new HTTPException(400, { message: 'Cannot remove the last owner of an org' });
      }
    }

    await executeQuery(
      tx,
      sql`DELETE FROM org_members WHERE org_id = ${ctx.orgId} AND user_id = ${targetId}`,
    );
  });
  return c.json({ ok: true });
});

// POST /:orgSlug/invites — create invite token
orgsRoute.post('/:orgSlug/invites', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const body = await c.req.json().catch(() => null);
  const { email, role, workspaceId, expiresInDays } = (body ?? {}) as {
    email?: string;
    role?: string;
    workspaceId?: string;
    expiresInDays?: number;
  };
  if (!email || typeof email !== 'string') throw new HTTPException(400, { message: 'email is required' });
  if (!role || !['owner', 'admin', 'member', 'editor', 'viewer'].includes(role)) {
    throw new HTTPException(400, { message: 'role must be owner, admin, member, editor, or viewer' });
  }

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const days = typeof expiresInDays === 'number' && expiresInDays > 0 ? expiresInDays : 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  try {
    await db.insert(inviteTokens).values({
      tokenHash,
      orgId: ctx.orgId,
      workspaceId: workspaceId ?? null,
      email: email.trim().toLowerCase(),
      role,
      invitedBy: user.id,
      expiresAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      throw new HTTPException(409, { message: 'A pending invite for this email already exists' });
    }
    throw err;
  }

  return c.json(
    {
      ok: true,
      inviteUrl: `${FRONTEND_URL}/invite/${rawToken}`,
      expiresAt: expiresAt.toISOString(),
    },
    201,
  );
});

// GET /:orgSlug/invites — list pending invites
orgsRoute.get('/:orgSlug/invites', async (c) => {
  const user = c.get('user') as { id: string };
  const ctx = await loadOrgCtx(user.id, c.req.param('orgSlug'));
  if (!ctx) throw new HTTPException(404, { message: 'Org not found' });
  assertOrgAdmin(ctx);

  const result = await query<{
    id: string;
    email: string;
    role: string;
    workspaceId: string | null;
    expiresAt: string;
    createdAt: string;
  }>(
    sql`SELECT id, email, role, workspace_id AS "workspaceId", expires_at AS "expiresAt", created_at AS "createdAt"
        FROM invite_tokens
        WHERE org_id = ${ctx.orgId} AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
  );
  return c.json(result.rows);
});

export default orgsRoute;
