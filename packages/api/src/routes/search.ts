import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  workspace_slug: string;
  breadcrumb: string[] | null;
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
  const createdAfter = c.req.query("createdAfter");
  const createdBefore = c.req.query("createdBefore");
  const parentId = c.req.query("parentId");
  const searchPattern = `%${rawQuery}%`;

  const filters: string[] = [];
  const params: (string | null)[] = [user.id, rawQuery, searchPattern];
  let paramIndex = 4;

  if (workspaceId) {
    filters.push(`p.workspace_id = $${paramIndex}`);
    params.push(workspaceId);
    paramIndex += 1;
  }

  if (createdAfter) {
    filters.push(`p.created_at >= $${paramIndex}`);
    params.push(createdAfter);
    paramIndex += 1;
  }

  if (createdBefore) {
    filters.push(`p.created_at <= $${paramIndex}`);
    params.push(createdBefore);
    paramIndex += 1;
  }

  if (parentId === "root") {
    filters.push("p.parent_id is null");
  } else if (parentId) {
    filters.push(`p.parent_id = $${paramIndex}`);
    params.push(parentId);
    paramIndex += 1;
  }

  const whereClause = filters.length > 0 ? ` and ${filters.join(" and ")}` : "";

  const result = await pool.query(
    `select p.id,
      p.title,
      p.icon,
      w.slug as workspace_slug,
      coalesce(breadcrumbs.breadcrumb, '{}'::text[]) as breadcrumb,
      ts_rank(p.title_search, plainto_tsquery('english', $2)) as rank
    from pages p
    join workspaces w on w.id = p.workspace_id
    join workspace_members wm on wm.workspace_id = p.workspace_id
    left join lateral (
      with recursive ancestors as (
        select id, title, parent_id, 1 as depth from pages where id = p.parent_id
        union all
        select p2.id, p2.title, p2.parent_id, a.depth + 1 from pages p2
        join ancestors a on p2.id = a.parent_id where a.depth < 3
      )
      select array_agg(title order by depth desc) as breadcrumb from ancestors
    ) breadcrumbs on true
    where wm.user_id = $1
      and p.is_deleted = false
      and (p.title_search @@ plainto_tsquery('english', $2) or p.title ilike $3)
      ${whereClause}
    order by rank desc nulls last
    limit 20`,
    params
  );

  const results = (result.rows as SearchRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    icon: row.icon,
    workspaceSlug: row.workspace_slug,
    breadcrumb: row.breadcrumb ?? [],
    path: [row.title],
  }));

  return c.json({ results });
});

export default searchRoute;
