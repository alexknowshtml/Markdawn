import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  workspace_slug: string;
};

const searchRoute = new Hono();

searchRoute.use("*", requireAuth);

searchRoute.get("/", async (c) => {
  const rawQuery = c.req.query("q")?.trim() ?? "";
  if (!rawQuery) {
    return c.json({ results: [] });
  }

  const user = c.get("user") as { id: string };
  const workspaceId = c.req.query("workspaceId");
  const searchPattern = `%${rawQuery}%`;

  if (workspaceId) {
    const result = await pool.query(
      "select p.id, p.title, p.icon, w.slug as workspace_slug from pages p join workspaces w on w.id = p.workspace_id join workspace_members wm on wm.workspace_id = p.workspace_id where wm.user_id = $1 and p.workspace_id = $2 and p.title ilike $3 order by p.updated_at desc nulls last, p.created_at desc limit 20",
      [user.id, workspaceId, searchPattern]
    );

    const results = (result.rows as SearchRow[]).map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      workspaceSlug: row.workspace_slug,
      path: [row.title],
    }));

    return c.json({ results });
  }

  const result = await pool.query(
    "select p.id, p.title, p.icon, w.slug as workspace_slug from pages p join workspaces w on w.id = p.workspace_id join workspace_members wm on wm.workspace_id = p.workspace_id where wm.user_id = $1 and p.title ilike $2 order by p.updated_at desc nulls last, p.created_at desc limit 20",
    [user.id, searchPattern]
  );

  const results = (result.rows as SearchRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    icon: row.icon,
    workspaceSlug: row.workspace_slug,
    path: [row.title],
  }));

  return c.json({ results });
});

export default searchRoute;
