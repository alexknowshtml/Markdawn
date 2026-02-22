import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

const templatesRoute = new Hono();

templatesRoute.use("*", requireAuth);

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

templatesRoute.get("/", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    "select id, workspace_id as \"workspaceId\", title, icon, description, content_blocks as \"contentBlocks\", created_by as \"createdBy\", created_at as \"createdAt\", updated_at as \"updatedAt\" from templates where workspace_id = $1 order by created_at desc",
    [workspaceId]
  );

  return c.json(result.rows);
});

templatesRoute.post("/", async (c) => {
  const body = await c.req.json();
  const { workspaceId, title, icon, description, contentBlocks } = body;

  if (!workspaceId || typeof workspaceId !== "string") {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  if (!title || typeof title !== "string") {
    throw new HTTPException(400, { message: "title is required" });
  }

  if (!Array.isArray(contentBlocks)) {
    throw new HTTPException(400, { message: "contentBlocks must be an array" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    `insert into templates (workspace_id, title, icon, description, content_blocks, created_by)
     values ($1, $2, $3, $4, $5, $6)
     returning id, workspace_id as "workspaceId", title, icon, description, content_blocks as "contentBlocks", created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"`,
    [workspaceId, title.trim(), icon ?? null, description ?? null, JSON.stringify(contentBlocks), user.id]
  );

  return c.json(result.rows[0]);
});

templatesRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user") as { id: string };

  // First get the template to check workspace
  const templateResult = await pool.query(
    "select workspace_id from templates where id = $1 limit 1",
    [id]
  );

  if (templateResult.rowCount === 0) {
    throw new HTTPException(404, { message: "Template not found" });
  }

  const workspaceId = templateResult.rows[0].workspace_id;
  await ensureWorkspaceMember(workspaceId, user.id);

  await pool.query("delete from templates where id = $1", [id]);

  return c.json({ success: true });
});

export default templatesRoute;
