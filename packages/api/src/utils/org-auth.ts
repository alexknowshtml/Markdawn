import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';

export type OrgRole = 'owner' | 'admin' | 'member';
export type WsRole = 'admin' | 'editor' | 'viewer';

export type OrgContext = {
  orgId: string;
  orgRole: OrgRole | null;
  isSuper: boolean;
};

export type WorkspaceContext = {
  workspaceId: string;
  wsRole: WsRole | null;
  visibility: 'open' | 'private';
  canAccess: boolean;
};

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'org'
  );
}

export async function loadOrgCtx(userId: string, orgSlug: string): Promise<OrgContext | null> {
  const result = await query<{ id: string; role: string | null; systemRole: string | null }>(
    sql`SELECT o.id, om.role, u.system_role AS "systemRole"
        FROM orgs o
        JOIN users u ON u.id = ${userId}
        LEFT JOIN org_members om ON om.org_id = o.id AND om.user_id = ${userId}
        WHERE o.slug = ${orgSlug} AND o.archived_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const isSuper = row.systemRole === 'super_admin';
  if (!row.role && !isSuper) return null;
  return { orgId: row.id, orgRole: (row.role as OrgRole) ?? null, isSuper };
}

export async function loadWorkspaceCtx(
  orgId: string,
  workspaceSlug: string,
  userId: string,
  orgCtx: OrgContext,
): Promise<WorkspaceContext | null> {
  const result = await query<{ id: string; visibility: string; role: string | null }>(
    sql`SELECT w.id, w.visibility, wm.role
        FROM workspaces w
        LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = ${userId}
        WHERE w.org_id = ${orgId} AND w.slug = ${workspaceSlug} AND w.archived_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const visibility = row.visibility as 'open' | 'private';
  const wsRole = (row.role as WsRole) ?? null;
  const canAccess = orgCtx.isSuper || visibility === 'open' || wsRole !== null;
  return { workspaceId: row.id, wsRole, visibility, canAccess };
}

export function assertOrgAdmin(ctx: OrgContext): void {
  if (!ctx.isSuper && ctx.orgRole !== 'owner' && ctx.orgRole !== 'admin') {
    throw new HTTPException(403, { message: 'Org admin access required' });
  }
}

export function assertOrgOwner(ctx: OrgContext): void {
  if (!ctx.isSuper && ctx.orgRole !== 'owner') {
    throw new HTTPException(403, { message: 'Org owner access required' });
  }
}

export async function assertEntityWorkspaceAccess(
  workspaceId: string | null | undefined,
  userId: string,
  executor: QueryExecutor = db,
): Promise<void> {
  if (!workspaceId) return;
  const result = await executeQuery<{
    visibility: string;
    ws_role: string | null;
    org_role: string | null;
    system_role: string | null;
  }>(
    executor,
    sql`SELECT w.visibility,
            wm.role AS ws_role,
            om.role AS org_role,
            u.system_role
        FROM workspaces w
        JOIN orgs o ON o.id = w.org_id
        JOIN users u ON u.id = ${userId}
        LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = ${userId}
        LEFT JOIN org_members om ON om.org_id = o.id AND om.user_id = ${userId}
        WHERE w.id = ${workspaceId} AND w.archived_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new HTTPException(403, { message: "You don't have access to this workspace" });
  }
  const isSuper = row.system_role === 'super_admin';
  const isOrgAdmin = row.org_role === 'owner' || row.org_role === 'admin';
  const isOrgMember = row.org_role !== null;
  const isWorkspaceMember = row.ws_role !== null;
  const allowed =
    isSuper || isOrgAdmin || isWorkspaceMember || (isOrgMember && row.visibility === 'open');
  if (!allowed) {
    throw new HTTPException(403, { message: "You don't have access to this workspace" });
  }
}

export function assertWsAdmin(wsCtx: WorkspaceContext, orgCtx: OrgContext): void {
  if (
    !orgCtx.isSuper &&
    orgCtx.orgRole !== 'owner' &&
    orgCtx.orgRole !== 'admin' &&
    wsCtx.wsRole !== 'admin'
  ) {
    throw new HTTPException(403, { message: 'Workspace admin access required' });
  }
}
