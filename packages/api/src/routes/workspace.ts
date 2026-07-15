import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { lockWorkspaceAccessMutation } from '../utils/share-access';
import { notifyWorkspaceEvent } from '../utils/share-notify';

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
    `select wm.workspace_owner_id as "ownerId",
            owner.name as "ownerName",
            wm.role,
            wm.created_at as "joinedAt"
     from workspace_members wm
     join users owner on owner.id = wm.workspace_owner_id
     where wm.member_id = $1
     order by wm.created_at asc`,
    [user.id],
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
    `SELECT
       wm.id,
       wm.workspace_owner_id,
       wm.member_id,
       u.name AS member_name,
       u.email AS member_email,
       u.avatar_url AS member_avatar_url,
       wm.role,
       wm.created_at
     FROM workspace_members wm
     JOIN users u ON u.id = wm.member_id
     WHERE wm.workspace_owner_id = $1
     ORDER BY wm.created_at ASC`,
    [user.id],
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

  // Find the user by email
  const userResult = await query(
    'SELECT id, name FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email.trim()],
  );
  const targetUser = userResult.rows[0] as { id: string; name: string } | undefined;
  if (!targetUser) {
    throw new HTTPException(404, { message: 'User not found' });
  }

  // Can't invite yourself
  if (targetUser.id === user.id) {
    throw new HTTPException(400, { message: 'Cannot invite yourself' });
  }

  // Membership uniqueness is directional: each user owns an independent workspace.
  const existingResult = await query(
    `SELECT id FROM workspace_members
     WHERE workspace_owner_id = $1 AND member_id = $2
     LIMIT 1`,
    [user.id, targetUser.id],
  );
  if (existingResult.rowCount && existingResult.rowCount > 0) {
    throw new HTTPException(409, { message: 'User is already a member of this workspace' });
  }

  const inviteMessage = `Added ${targetUser.name ?? email} as ${role} to workspace`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const insertResult = await executeQuery(
      tx,
      `INSERT INTO workspace_members (workspace_owner_id, member_id, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [user.id, targetUser.id, role],
    );

    if (!insertResult.rowCount || insertResult.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to add workspace member' });
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

  const memberResult = await query('SELECT name FROM users WHERE id = $1', [memberId]);
  const memberName =
    (memberResult.rows[0] as { name: string | null } | undefined)?.name ?? 'Member';

  const roleMessage = `Changed ${memberName}'s role to ${role}`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const updateResult = await executeQuery(
      tx,
      `UPDATE workspace_members SET role = $1
       WHERE workspace_owner_id = $2 AND member_id = $3
       RETURNING id`,
      [role, user.id, memberId],
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
      'SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_id = $2 LIMIT 1',
      [workspaceOwnerId, memberId],
    );
    if (!ownerCheck.rowCount || ownerCheck.rowCount === 0) {
      throw new HTTPException(403, { message: 'Only the workspace owner can remove members' });
    }
  }

  const memberResult = await query('SELECT name FROM users WHERE id = $1', [memberId]);
  const memberName =
    (memberResult.rows[0] as { name: string | null } | undefined)?.name ?? 'Member';

  const removeMessage = isSelfRemoval
    ? 'Left the workspace'
    : `Removed ${memberName} from workspace`;

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, workspaceOwnerId);
    const deleteResult = await executeQuery(
      tx,
      'DELETE FROM workspace_members WHERE workspace_owner_id = $1 AND member_id = $2 RETURNING id',
      [workspaceOwnerId, memberId],
    );

    if (!deleteResult.rowCount || deleteResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Member not found' });
    }

    await notifyWorkspaceEvent('member_removed', workspaceOwnerId, memberId, removeMessage, tx);
  });

  return c.json({ ok: true, message: removeMessage });
});

export default workspaceRoute;
