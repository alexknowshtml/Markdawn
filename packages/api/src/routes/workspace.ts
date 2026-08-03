import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import { db } from '../db/connection';
import { accounts, users } from '../db/schema';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { lockWorkspaceAccessMutation } from '../utils/share-access';
import { notifyWorkspaceEvent } from '../utils/share-notify';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

const workspaceRoute = new Hono();

workspaceRoute.use('*', requireAuth);

type WorkspaceRole = 'viewer' | 'editor' | 'admin';

const parseWorkspaceRole = (value: unknown, defaultRole?: WorkspaceRole): WorkspaceRole => {
  if (value === undefined && defaultRole) return defaultRole;
  if (value === 'viewer' || value === 'editor' || value === 'admin') return value;
  throw new HTTPException(400, { message: 'Invalid workspace role' });
};

/**
 * GET /workspace/memberships — list workspaces the caller has joined.
 */
workspaceRoute.get('/memberships', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await query(
    sql`select wm.workspace_owner_id as "ownerId",
            owner.name as "ownerName",
            wm.role,
            wm.created_at as "joinedAt",
            shared_org.org_id as "orgId"
     from workspace_members wm
     join users owner on owner.id = wm.workspace_owner_id
     left join org_members my_orgs on my_orgs.user_id = ${user.id}
     left join org_members shared_org
       on shared_org.org_id = my_orgs.org_id
       and shared_org.user_id = wm.workspace_owner_id
     where wm.member_id = ${user.id}
     order by wm.created_at asc`,
  );
  return c.json(result.rows);
});

/**
 * GET /workspace/members — list all members of the caller's workspace
 * Only the workspace owner can list members.
 */
workspaceRoute.get('/members', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    sql`SELECT
       wm.id,
       wm.workspace_owner_id AS "workspaceOwnerId",
       wm.member_id AS "memberId",
       u.name AS "memberName",
       u.email AS "memberEmail",
       u.avatar_url AS "memberAvatarUrl",
       wm.role,
       wm.created_at AS "createdAt"
     FROM workspace_members wm
     JOIN users u ON u.id = wm.member_id
     WHERE wm.workspace_owner_id = ${user.id}
     ORDER BY wm.created_at ASC`,
  );

  return c.json(result.rows);
});

/**
 * POST /workspace/members/invite — invite a user to the caller's workspace
 * Only the workspace owner or an admin can invite members.
 */
workspaceRoute.post('/members/invite', async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { email, role: rawRole } = body as { email?: string; role?: string };
  if (!email || typeof email !== 'string') {
    throw new HTTPException(400, { message: 'Email is required' });
  }

  const role = parseWorkspaceRole(rawRole, 'editor');
  const trimmedEmail = email.trim();

  // Find the user by email; create account if they don't exist yet
  const userResult = await query(
    sql`SELECT id, name FROM users WHERE lower(email) = lower(${trimmedEmail}) LIMIT 1`,
  );
  let targetUser = userResult.rows[0] as { id: string; name: string } | undefined;
  let wasCreated = false;

  if (!targetUser) {
    const now = new Date();
    const [newUser] = await db
      .insert(users)
      .values({
        email: trimmedEmail,
        name: trimmedEmail.split('@')[0],
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id, name: users.name })
      .catch(() => []);

    if (!newUser) {
      throw new HTTPException(400, { message: 'Could not create an account for that email.' });
    }

    // Credential account with no password — they set it via the reset link
    await db.insert(accounts).values({
      accountId: newUser.id,
      providerId: 'credential',
      userId: newUser.id,
      password: null,
      createdAt: now,
      updatedAt: now,
    });

    targetUser = newUser;
    wasCreated = true;

    // Send "set your password" email — non-fatal if Resend domain not yet verified
    auth.api.requestPasswordReset({
      body: { email: trimmedEmail, redirectTo: `${FRONTEND_URL}/reset-password` },
      headers: new Headers(),
    }).catch(() => null);
  }

  // Can't invite yourself
  if (targetUser.id === user.id) {
    throw new HTTPException(400, { message: 'Cannot invite yourself' });
  }

  // Membership uniqueness is directional: each user owns an independent workspace.
  const existingResult = await query(
    sql`SELECT id FROM workspace_members
     WHERE workspace_owner_id = ${user.id} AND member_id = ${targetUser.id}
     LIMIT 1`,
  );
  if (existingResult.rowCount && existingResult.rowCount > 0) {
    throw new HTTPException(409, { message: 'User is already a member of this workspace' });
  }

  const inviteMessage = wasCreated
    ? `Invited ${targetUser.name ?? trimmedEmail} as ${role} — they'll get an email to set their password`
    : `Added ${targetUser.name ?? trimmedEmail} as ${role} to workspace`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const insertResult = await executeQuery(
      tx,
      sql`INSERT INTO workspace_members (workspace_owner_id, member_id, role)
       VALUES (${user.id}, ${targetUser.id}, ${role})
       ON CONFLICT (workspace_owner_id, member_id) DO NOTHING
       RETURNING id`,
    );

    if (!insertResult.rowCount || insertResult.rowCount === 0) {
      throw new HTTPException(409, { message: 'User is already a member of this workspace' });
    }

    await notifyWorkspaceEvent('member_added', user.id, targetUser.id, inviteMessage, tx);
  });

  return c.json({
    ok: true,
    memberId: targetUser.id,
    name: targetUser.name,
    message: inviteMessage,
  });
});

/**
 * PATCH /workspace/members/:memberId/role — change a member's role
 * Only the workspace owner can change roles.
 */
workspaceRoute.patch('/members/:memberId/role', async (c) => {
  const user = c.get('user') as { id: string };
  const memberId = c.req.param('memberId');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { role: rawRole } = body as { role?: string };
  const role = parseWorkspaceRole(rawRole);

  const memberResult = await query(sql`SELECT name FROM users WHERE id = ${memberId}`);
  const memberName =
    (memberResult.rows[0] as { name: string | null } | undefined)?.name ?? 'Member';

  const roleMessage = `Changed ${memberName}'s role to ${role}`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const updateResult = await executeQuery(
      tx,
      sql`UPDATE workspace_members SET role = ${role}
       WHERE workspace_owner_id = ${user.id} AND member_id = ${memberId}
       RETURNING id`,
    );

    if (!updateResult.rowCount || updateResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Member not found' });
    }

    await notifyWorkspaceEvent('role_changed', user.id, memberId, roleMessage, tx);
  });

  return c.json({ ok: true, message: roleMessage });
});

/**
 * DELETE /workspace/members/:memberId — remove a member from the workspace
 * The owner can remove anyone. A member can remove themselves (leave).
 */
workspaceRoute.delete('/members/:memberId', async (c) => {
  const user = c.get('user') as { id: string };
  const memberId = c.req.param('memberId');

  const isSelfRemoval = user.id === memberId;
  const workspaceOwnerId = isSelfRemoval ? c.req.query('workspaceOwnerId') : user.id;
  if (!workspaceOwnerId) {
    throw new HTTPException(400, { message: 'workspaceOwnerId is required to leave a workspace' });
  }
  if (isSelfRemoval && workspaceOwnerId === user.id) {
    throw new HTTPException(400, { message: 'Cannot leave your own workspace' });
  }

  if (!isSelfRemoval) {
    const ownerCheck = await query(
      sql`SELECT id FROM workspace_members WHERE workspace_owner_id = ${workspaceOwnerId} AND member_id = ${memberId} LIMIT 1`,
    );
    if (!ownerCheck.rowCount || ownerCheck.rowCount === 0) {
      throw new HTTPException(403, { message: 'Only the workspace owner can remove members' });
    }
  }

  const memberResult = await query(sql`SELECT name FROM users WHERE id = ${memberId}`);
  const memberName =
    (memberResult.rows[0] as { name: string | null } | undefined)?.name ?? 'Member';

  const removeMessage = isSelfRemoval
    ? 'Left the workspace'
    : `Removed ${memberName} from workspace`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, workspaceOwnerId);
    const deleteResult = await executeQuery(
      tx,
      sql`DELETE FROM workspace_members WHERE workspace_owner_id = ${workspaceOwnerId} AND member_id = ${memberId} RETURNING id`,
    );

    if (!deleteResult.rowCount || deleteResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Member not found' });
    }

    await notifyWorkspaceEvent('member_removed', workspaceOwnerId, memberId, removeMessage, tx);
  });

  return c.json({ ok: true, message: removeMessage });
});

export default workspaceRoute;
