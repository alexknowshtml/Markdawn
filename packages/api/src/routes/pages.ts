import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pages } from "../db";
import { pool } from "../db/connection";

type PageRow = typeof pages.$inferSelect;

const pagesRoute = new Hono();

pagesRoute.use("*", requireAuth);

const buildTree = (rows: PageRow[]) => {
  const nodes = rows.map((page) => ({
    ...page,
    ydoc: page.ydoc ? Array.from(page.ydoc) : null,
    children: [] as any[],
  }));
  const map = new Map<string, (typeof nodes)[number]>();
  nodes.forEach((node) => map.set(node.id, node));

  const roots: typeof nodes = [];
  nodes.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
};

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

const getPageById = async (pageId: string) => {
  const result = await pool.query("select * from pages where id = $1 limit 1", [pageId]);
  return (result.rows[0] as PageRow | undefined) ?? null;
};

const ensureWorkspaceForPage = (page: PageRow) => {
  if (!page.workspaceId) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }
};

pagesRoute.get("/tree", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    "select * from pages where workspace_id = $1 order by parent_id nulls first, position asc",
    [workspaceId]
  );

  return c.json(buildTree(result.rows as PageRow[]));
});

pagesRoute.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { workspaceId, parentId, title, icon } = body as {
    workspaceId?: string;
    parentId?: string | null;
    title?: string;
    icon?: string | null;
  };

  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  if (parentId) {
    const parent = await getPageById(parentId);
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new HTTPException(404, { message: "Parent page not found" });
    }
  }

  const positionResult = await pool.query(
    parentId
      ? "select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2"
      : "select max(position) as max_position from pages where workspace_id = $1 and parent_id is null",
    parentId ? [workspaceId, parentId] : [workspaceId]
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    "insert into pages (workspace_id, parent_id, title, icon, position, created_by) values ($1, $2, $3, $4, $5, $6) returning *",
    [
      workspaceId,
      parentId ?? null,
      typeof title === "string" && title.trim().length > 0 ? title.trim() : "Untitled",
      typeof icon === "string" && icon.trim().length > 0 ? icon.trim() : null,
      nextPosition,
      user.id,
    ]
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to create page" });
  }

  const created = insertResult.rows[0] as PageRow;
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.get(":id", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  return c.json({ ...page, ydoc: page.ydoc ? Array.from(page.ydoc) : null });
});

pagesRoute.patch(":id", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { title, icon, parentId, position } = body as {
    title?: string;
    icon?: string | null;
    parentId?: string | null;
    position?: number;
  };

  const hasParentId = Object.prototype.hasOwnProperty.call(body, "parentId");
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: "Cannot set parent to self" });
    }
    const parent = await getPageById(parentId);
    if (!parent || parent.workspaceId !== page.workspaceId) {
      throw new HTTPException(404, { message: "Parent page not found" });
    }
  }

  const nextTitle = typeof title === "string" ? (title.trim().length > 0 ? title.trim() : "Untitled") : page.title;
  const nextIcon = typeof icon === "string" ? (icon.trim().length > 0 ? icon.trim() : null) : icon === null ? null : page.icon;
  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition = typeof position === "number" && Number.isFinite(position) ? position : page.position;

  const updateResult = await pool.query(
    "update pages set title = $1, icon = $2, parent_id = $3, position = $4, updated_at = now() where id = $5 returning *",
    [nextTitle, nextIcon, nextParent, nextPosition, pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to update page" });
  }

  const updated = updateResult.rows[0] as PageRow;
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(":id/content", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { ydoc } = body as { ydoc?: number[] };
  if (!Array.isArray(ydoc)) {
    throw new HTTPException(400, { message: "ydoc is required" });
  }

  const ydocBuffer = Buffer.from(ydoc);
  const updateResult = await pool.query(
    "update pages set ydoc = $1, updated_at = now() where id = $2",
    [ydocBuffer, pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to update page content" });
  }

  return c.json({ success: true });
});

pagesRoute.patch(":id/move", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { parentId, position } = body as {
    parentId?: string | null;
    position?: number;
  };

  const hasParentId = Object.prototype.hasOwnProperty.call(body, "parentId");
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: "Cannot set parent to self" });
    }
    const parent = await getPageById(parentId);
    if (!parent || parent.workspaceId !== page.workspaceId) {
      throw new HTTPException(404, { message: "Parent page not found" });
    }
  }

  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition = typeof position === "number" && Number.isFinite(position) ? position : page.position;

  const updateResult = await pool.query(
    "update pages set parent_id = $1, position = $2, updated_at = now() where id = $3 returning *",
    [nextParent, nextPosition, pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to move page" });
  }

  const updated = updateResult.rows[0] as PageRow;
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.delete(":id", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const workspacePages = await pool.query(
    "select id, parent_id from pages where workspace_id = $1",
    [page.workspaceId]
  );

  const childMap = new Map<string, string[]>();
  (workspacePages.rows as { id: string; parent_id: string | null }[]).forEach((item) => {
    if (!item.parent_id) {
      return;
    }
    const list = childMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childMap.set(item.parent_id, list);
  });

  const toDelete = new Set<string>();
  const stack = [pageId];
  while (stack.length) {
    const current = stack.pop();
    if (!current || toDelete.has(current)) {
      continue;
    }
    toDelete.add(current);
    const children = childMap.get(current);
    if (children) {
      children.forEach((child) => stack.push(child));
    }
  }

  await pool.query("delete from pages where id = any($1)", [Array.from(toDelete)]);

  return c.json({ deleted: true });
});

export default pagesRoute;
