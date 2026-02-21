import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ServerBlockNoteEditor } from "@blocknote/server-util";
import { requireAuth } from "../middleware/auth";
import { pages } from "../db";
import { pool } from "../db/connection";

type PageRow = typeof pages.$inferSelect;
type RawPageRow = PageRow & {
  workspace_id?: string | null;
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
};

const pagesRoute = new Hono();

pagesRoute.use("*", requireAuth);

type BlockNoteServerInstance = ReturnType<typeof ServerBlockNoteEditor.create>;
type MarkdownBlockInput = Parameters<BlockNoteServerInstance["blocksToMarkdownLossy"]>[0];

let blocknoteServerPromise: Promise<BlockNoteServerInstance> | null = null;

const getBlockNoteServer = () => {
  if (!blocknoteServerPromise) {
    blocknoteServerPromise = import("@blocknote/server-util").then(({ ServerBlockNoteEditor }) =>
      ServerBlockNoteEditor.create()
    );
  }

  return blocknoteServerPromise;
};

const buildTree = (rows: PageRow[]) => {
  type PageNode = PageRow & { ydoc: number[] | null; children: PageNode[] };
  const nodes: PageNode[] = rows.map((page) => ({
    ...page,
    ydoc: page.ydoc ? Array.from(page.ydoc) : null,
    children: [],
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
  const row = (result.rows[0] as RawPageRow | undefined) ?? null;
  return row ? normalizePageRow(row) : null;
};

const normalizePageRow = (row: RawPageRow): PageRow => ({
  ...row,
  workspaceId: row.workspaceId ?? row.workspace_id ?? null,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
});

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
    "select * from pages where workspace_id = $1 and is_deleted = false order by parent_id nulls first, position asc",
    [workspaceId]
  );

  return c.json(buildTree((result.rows as RawPageRow[]).map(normalizePageRow)));
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

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.get("/trash", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    "select * from pages where workspace_id = $1 and is_deleted = true order by deleted_at desc nulls last, position asc",
    [workspaceId]
  );

  return c.json((result.rows as RawPageRow[]).map(normalizePageRow));
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

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(":id/restore", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const updateResult = await pool.query(
    "update pages set is_deleted = false, deleted_at = null, updated_at = now() where id = $1 returning *",
    [pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to restore page" });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
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

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.get(":id/export/markdown", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  if (!page.ydoc || page.ydoc.length === 0) {
    const emptyFilename = `${page.title || "Untitled"}.md`;
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${emptyFilename}"`);
    return c.body("");
  }

  let blocks: MarkdownBlockInput;
  try {
    const decoded = new TextDecoder().decode(page.ydoc);
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid block data");
    }
    blocks = parsed as MarkdownBlockInput;
  } catch {
    throw new HTTPException(500, { message: "Failed to decode page content" });
  }

  const blocknoteServer = await getBlockNoteServer();
  const markdown = await blocknoteServer.blocksToMarkdownLossy(blocks);
  const filename = `${page.title || "Untitled"}.md`;
  c.header("Content-Type", "text/markdown");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(markdown);
});

pagesRoute.post(":id/import/markdown", async (c) => {
  const pageId = c.req.param("id");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  ensureWorkspaceForPage(page);
  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspaceId!, user.id);

  const contentType = c.req.header("content-type") ?? "";
  let markdown = "";

  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new HTTPException(400, { message: "Invalid body" });
    }
    const bodyMarkdown = (body as { markdown?: string }).markdown;
    markdown = typeof bodyMarkdown === "string" ? bodyMarkdown : "";
  } else if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get("file");
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "File is required" });
    }
    markdown = await file.text();
  } else {
    throw new HTTPException(415, { message: "Unsupported content type" });
  }

  if (!markdown.trim()) {
    throw new HTTPException(400, { message: "Markdown is required" });
  }

  const blocknoteServer = await getBlockNoteServer();
  const blocks = await blocknoteServer.tryParseMarkdownToBlocks(markdown);
  const encoded = new TextEncoder().encode(JSON.stringify(blocks));

  const updateResult = await pool.query(
    "update pages set ydoc = $1, updated_at = now() where id = $2",
    [Buffer.from(encoded), pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to import page content" });
  }

  return c.json({ success: true });
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

  const updateResult = await pool.query(
    "update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1",
    [pageId]
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: "Failed to delete page" });
  }

  return c.json({ deleted: true });
});

pagesRoute.delete(":id/permanent", async (c) => {
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
