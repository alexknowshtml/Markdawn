import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import JSZip from "jszip";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type PageExportRow = {
  id: string;
  title: string | null;
  ydoc: Buffer | null;
};

const exportRoute = new Hono();

exportRoute.use("*", requireAuth);

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

const slugifyFilename = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

exportRoute.get(":workspaceId/export", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    throw new HTTPException(400, { message: "workspaceId is required" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const result = await pool.query(
    "select id, title, ydoc from pages where workspace_id = $1 and is_deleted = false order by parent_id nulls first, position asc",
    [workspaceId]
  );

  const pages = result.rows as PageExportRow[];
  const zip = new JSZip();
  const usedNames = new Map<string, number>();

  pages.forEach((page, index) => {
    const title = typeof page.title === "string" && page.title.trim().length > 0 ? page.title.trim() : "Untitled";
    const baseSlug = slugifyFilename(title);
    const baseName = baseSlug.length > 0 ? baseSlug : `page-${index + 1}`;
    const seenCount = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, seenCount + 1);
    const filename = seenCount > 0 ? `${baseName}-${seenCount + 1}.md` : `${baseName}.md`;
    let content = "";
    if (page.ydoc && page.ydoc.length > 0) {
      const hasNullByte = page.ydoc.includes(0);
      if (!hasNullByte) {
        try {
          content = new TextDecoder().decode(page.ydoc);
        } catch {
          content = "";
        }
      }
    }
    if (!content.trim()) {
      content = `# ${title}

`;
    } else {
      content = `# ${title}

${content}`;
    }
    zip.file(filename, content);
  });

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", "attachment; filename=\"workspace-export.zip\"");
  return c.newResponse(arrayBuffer, 200);
});

export default exportRoute;
