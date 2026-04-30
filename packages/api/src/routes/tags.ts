import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

const tagsRoute = new Hono();
tagsRoute.use("*", requireAuth);

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );
  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

tagsRoute.get("/", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    `select t.id, t.name, count(pt.page_id) as page_count
     from tags t
     left join page_tags pt on pt.tag_id = t.id
     where t.workspace_id = $1
     group by t.id, t.name
     order by page_count desc, t.name asc`,
    [workspaceId]
  );

  return c.json(result.rows);
});

tagsRoute.get("/pages", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const tagId = c.req.query("tagId");

  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }
  if (!tagId) {
    throw new HTTPException(400, { message: "tagId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    `select p.id, p.title, p.icon, p.parent_id as "parentId"
     from pages p
     join page_tags pt on pt.page_id = p.id
     where pt.tag_id = $1 and p.workspace_id = $2 and p.is_deleted = false
     order by p.updated_at desc`,
    [tagId, workspaceId]
  );

  return c.json(result.rows);
});

export default tagsRoute;
