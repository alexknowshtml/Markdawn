import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import type { OrgRole } from '../utils/org-auth';

const invitesRoute = new Hono();

// GET /validate/:token — public, no auth
invitesRoute.get('/validate/:token', async (c) => {
  const tokenHash = createHash('sha256').update(c.req.param('token')).digest('hex');

  const result = await query<{
    id: string;
    orgId: string;
    orgName: string;
    orgSlug: string;
    workspaceId: string | null;
    workspaceName: string | null;
    email: string;
    role: string;
    expiresAt: string;
  }>(
    sql`SELECT it.id, it.org_id AS "orgId", o.name AS "orgName", o.slug AS "orgSlug",
               it.workspace_id AS "workspaceId", w.name AS "workspaceName",
               it.email, it.role, it.expires_at AS "expiresAt"
        FROM invite_tokens it
        JOIN orgs o ON o.id = it.org_id
        LEFT JOIN workspaces w ON w.id = it.workspace_id
        WHERE it.token_hash = ${tokenHash}
          AND it.used_at IS NULL
          AND it.expires_at > now()`,
  );

  if (!result.rows[0]) throw new HTTPException(404, { message: 'Invite not found or expired' });
  return c.json(result.rows[0]);
});

// POST /accept/:token — auth required
invitesRoute.post('/accept/:token', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const tokenHash = createHash('sha256').update(c.req.param('token')).digest('hex');

  const inviteResult = await query<{
    id: string;
    orgId: string;
    workspaceId: string | null;
    email: string;
    role: string;
  }>(
    sql`SELECT id, org_id AS "orgId", workspace_id AS "workspaceId", email, role
        FROM invite_tokens
        WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()`,
  );

  const invite = inviteResult.rows[0];
  if (!invite) throw new HTTPException(404, { message: 'Invite not found or expired' });

  const callerRow = await query<{ email: string }>(
    sql`SELECT email FROM users WHERE id = ${user.id}`,
  );
  if (callerRow.rows[0]?.email?.toLowerCase() !== invite.email.toLowerCase()) {
    throw new HTTPException(403, { message: 'This invite is for a different email address' });
  }

  await db.transaction(async (tx) => {
    const orgRole: OrgRole = invite.workspaceId ? 'member' : (invite.role as OrgRole);

    await executeQuery(
      tx,
      sql`INSERT INTO org_members (org_id, user_id, role)
          VALUES (${invite.orgId}, ${user.id}, ${orgRole})
          ON CONFLICT (org_id, user_id) DO NOTHING`,
    );

    if (invite.workspaceId) {
      await executeQuery(
        tx,
        sql`INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${invite.workspaceId}, ${user.id}, ${invite.role})
            ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      );
    }

    await executeQuery(
      tx,
      sql`UPDATE invite_tokens SET used_at = now() WHERE id = ${invite.id}`,
    );
  });

  return c.json({ ok: true, orgId: invite.orgId, workspaceId: invite.workspaceId });
});

export default invitesRoute;
