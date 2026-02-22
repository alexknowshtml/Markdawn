import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type FavoriteRow = {
  page_id: string;
  title: string;
  icon: string | null;
  created_at: Date | null;
};

const favoritesRoute = new Hono();

favoritesRoute.use("*", requireAuth);

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

const getPageWorkspace = async (pageId: string) => {
  const result = await pool.query(
    "select id, workspace_id, is_deleted from pages where id = $1 limit 1",
    [pageId]
  );

  return (result.rows[0] as { id: string; workspace_id: string | null; is_deleted: boolean | null } | undefined) ?? null;
};

favoritesRoute.get("/", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    "select uf.page_id, p.title, p.icon, uf.created_at from user_favorites uf join pages p on p.id = uf.page_id where uf.user_id = $1 and p.workspace_id = $2 and p.is_deleted = false order by uf.created_at desc nulls last",
    [user.id, workspaceId]
  );

  const favorites = (result.rows as FavoriteRow[]).map((row) => ({
    pageId: row.page_id,
    title: row.title,
    icon: row.icon,
    createdAt: row.created_at,
  }));

  return c.json({ favorites });
});

favoritesRoute.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { pageId } = body as { pageId?: string };
  if (!pageId) {
    throw new HTTPException(400, { message: "pageId is required" });
  }

  const page = await getPageWorkspace(pageId);
  if (!page || !page.workspace_id || page.is_deleted) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const insertResult = await pool.query(
    "insert into user_favorites (user_id, page_id, workspace_id) values ($1, $2, $3) on conflict (user_id, page_id) do nothing returning id",
    [user.id, pageId, page.workspace_id]
  );

  if (insertResult.rowCount === 0) {
    return c.json({ ok: true });
  }

  return c.json({ ok: true }, 201);
});

favoritesRoute.delete(":pageId", async (c) => {
  const pageId = c.req.param("pageId");
  const page = await getPageWorkspace(pageId);
  if (!page || !page.workspace_id) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  await pool.query("delete from user_favorites where user_id = $1 and page_id = $2", [
    user.id,
    pageId,
  ]);

  return c.json({ deleted: true });
});

export default favoritesRoute;
