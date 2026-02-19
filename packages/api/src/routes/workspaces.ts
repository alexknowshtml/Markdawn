import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  owner_id: string | null;
  is_personal: boolean | null;
  created_at: Date;
  updated_at: Date;
};

type WorkspaceMemberRow = {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  role: "owner" | "admin" | "member";
  joined_at: Date;
};

type WorkspaceMemberWithUser = WorkspaceMemberRow & {
  name: string;
  email: string;
  avatar_url: string | null;
};

const workspacesRoute = new Hono();

workspacesRoute.use("*", requireAuth);

const slugify = (name: string) => {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
};

const ensureUniqueSlug = async (baseSlug: string) => {
  let slug = baseSlug;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await pool.query("select id from workspaces where slug = $1 limit 1", [slug]);
    if (result.rowCount === 0) {
      return slug;
    }
    const suffix = Math.random().toString(36).slice(2, 8);
    slug = `${baseSlug}-${suffix}`;
  }
  throw new HTTPException(500, { message: "Failed to generate unique slug" });
};

const getWorkspaceBySlug = async (slug: string) => {
  const result = await pool.query("select * from workspaces where slug = $1 limit 1", [slug]);
  return (result.rows[0] as WorkspaceRow | undefined) ?? null;
};

const getMembership = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select * from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );
  return (result.rows[0] as WorkspaceMemberRow | undefined) ?? null;
};

const ensureMember = async (workspaceId: string, userId: string) => {
  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return membership;
};

const ensureRole = (membership: WorkspaceMemberRow, roles: WorkspaceMemberRow["role"][]) => {
  if (!roles.includes(membership.role)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

workspacesRoute.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const result = await pool.query(
    "select w.* from workspaces w join workspace_members wm on wm.workspace_id = w.id where wm.user_id = $1 order by w.created_at asc",
    [user.id]
  );

  return c.json(result.rows as WorkspaceRow[]);
});

workspacesRoute.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { name } = body as { name?: string };
  if (typeof name !== "string" || name.trim().length < 2) {
    throw new HTTPException(400, { message: "Name is required" });
  }

  const user = c.get("user") as { id: string };
  const baseSlug = slugify(name);
  const slug = await ensureUniqueSlug(baseSlug);

  await pool.query("begin");
  try {
    const insertResult = await pool.query(
      "insert into workspaces (name, slug, owner_id, is_personal) values ($1, $2, $3, false) returning *",
      [name.trim(), slug, user.id]
    );

    if (insertResult.rowCount === 0) {
      throw new HTTPException(500, { message: "Failed to create workspace" });
    }

    const workspace = insertResult.rows[0] as WorkspaceRow;

    await pool.query(
      "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')",
      [workspace.id, user.id]
    );

    await pool.query("commit");
    return c.json(workspace, 201);
  } catch (error) {
    await pool.query("rollback");
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(500, { message: "Failed to create workspace" });
  }
});

workspacesRoute.get(":slug", async (c) => {
  const slug = c.req.param("slug");
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }

  const user = c.get("user") as { id: string };
  const membership = await ensureMember(workspace.id, user.id);

  const membersResult = await pool.query(
    "select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.joined_at, u.name, u.email, u.avatar_url from workspace_members wm join users u on u.id = wm.user_id where wm.workspace_id = $1 order by case when wm.role = 'owner' then 0 when wm.role = 'admin' then 1 else 2 end, u.name",
    [workspace.id]
  );

  return c.json({
    workspace,
    members: membersResult.rows as WorkspaceMemberWithUser[],
    currentUserRole: membership.role,
  });
});

workspacesRoute.patch(":slug", async (c) => {
  const slug = c.req.param("slug");
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }

  const user = c.get("user") as { id: string };
  const membership = await ensureMember(workspace.id, user.id);
  ensureRole(membership, ["owner", "admin"]);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { name } = body as { name?: string };
  if (typeof name !== "string" || name.trim().length < 2) {
    throw new HTTPException(400, { message: "Name is required" });
  }

  const nextName = name.trim();
  const shouldUpdateSlug = nextName !== workspace.name;
  const nextSlug = shouldUpdateSlug ? await ensureUniqueSlug(slugify(nextName)) : workspace.slug;

  const updateResult = await pool.query(
    "update workspaces set name = $1, slug = $2, updated_at = now() where id = $3 returning *",
    [nextName, nextSlug, workspace.id]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to update workspace" });
  }

  return c.json(updateResult.rows[0] as WorkspaceRow);
});

workspacesRoute.delete(":slug", async (c) => {
  const slug = c.req.param("slug");
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }

  const user = c.get("user") as { id: string };
  const membership = await ensureMember(workspace.id, user.id);
  ensureRole(membership, ["owner"]);

  const deleteResult = await pool.query("delete from workspaces where id = $1", [workspace.id]);
  if (deleteResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to delete workspace" });
  }

  return c.json({ deleted: true });
});

workspacesRoute.post(":slug/members", async (c) => {
  const slug = c.req.param("slug");
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }

  const user = c.get("user") as { id: string };
  const membership = await ensureMember(workspace.id, user.id);
  ensureRole(membership, ["owner", "admin"]);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { email, role } = body as { email?: string; role?: WorkspaceMemberRow["role"] };
  if (typeof email !== "string" || email.trim().length === 0) {
    throw new HTTPException(400, { message: "Email is required" });
  }

  const desiredRole: WorkspaceMemberRow["role"] = role && ["owner", "admin", "member"].includes(role)
    ? role
    : "member";

  const userResult = await pool.query(
    "select id from users where lower(email) = lower($1) limit 1",
    [email.trim()]
  );

  if (userResult.rowCount === 0) {
    throw new HTTPException(404, { message: "User not found" });
  }

  const targetUserId = userResult.rows[0]?.id as string;
  const existing = await getMembership(workspace.id, targetUserId);
  if (existing) {
    return c.json({ ok: true });
  }

  await pool.query(
    "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)",
    [workspace.id, targetUserId, desiredRole]
  );

  return c.json({ ok: true });
});

workspacesRoute.delete(":slug/members/:userId", async (c) => {
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }

  const user = c.get("user") as { id: string };
  const membership = await ensureMember(workspace.id, user.id);
  ensureRole(membership, ["owner", "admin"]);

  const targetMembership = await getMembership(workspace.id, targetUserId);
  if (!targetMembership) {
    throw new HTTPException(404, { message: "Member not found" });
  }

  if (targetMembership.role === "owner" || workspace.owner_id === targetUserId) {
    throw new HTTPException(400, { message: "Cannot remove owner" });
  }

  await pool.query(
    "delete from workspace_members where workspace_id = $1 and user_id = $2",
    [workspace.id, targetUserId]
  );

  return c.json({ ok: true });
});

export default workspacesRoute;
