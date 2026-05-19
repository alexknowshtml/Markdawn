import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { pages } from '../db';
import { pool } from '../db/connection';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import {
  createYjsDocWithTitle,
  resolveWikilinkTargets,
  stripLeadingH1,
} from '../utils/markdown-to-yjs';

type PageRow = typeof pages.$inferSelect;
type RawPageRow = PageRow & {
  workspace_id?: string | null;
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
};

const ALLOWED_IMAGE_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp', 'svg']);

const importRoute = new Hono();

importRoute.use('*', requireAuth);

const normalizePageRow = (row: RawPageRow): PageRow => ({
  ...row,
  workspaceId: row.workspaceId ?? row.workspace_id ?? null,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
});

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

const getExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
};

const isImageFile = (filename: string): boolean => {
  const ext = getExtension(filename);
  return ALLOWED_IMAGE_TYPES.has(ext);
};

const parseFrontmatter = (
  content: string,
): { title: string; body: string; properties: Record<string, unknown> } => {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    const title = h1Match?.[1]?.trim() ?? '';
    return {
      title,
      body: content,
      properties: {},
    };
  }

  const frontmatterBlock = match[1] ?? '';
  const body = content.slice(match[0]?.length);

  const properties: Record<string, unknown> = {};
  const lines = frontmatterBlock.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] = [];
  let inArray = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      if (inArray && currentKey) {
        currentArray.push(
          trimmed
            .slice(2)
            .trim()
            .replace(/^["']|["']$/g, ''),
        );
      }
      continue;
    }

    if (inArray && currentKey) {
      properties[currentKey] = currentArray;
      inArray = false;
      currentArray = [];
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value === '' || value === '[]') {
        inArray = true;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        properties[currentKey] = value
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''));
      } else {
        properties[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (inArray && currentKey) {
    properties[currentKey] = currentArray;
  }

  const title = typeof properties.title === 'string' ? properties.title : '';
  properties.title = undefined;

  return { title, body, properties };
};

const containsImageReferences = (content: string): boolean => {
  return (
    /!\[\[([^\]]+\.(?:jpe?g|png|gif|webp|svg))\]\]/i.test(content) ||
    /\[\[([^\]]+\.(?:jpe?g|png|gif|webp|svg))\]\]/i.test(content) ||
    /!\[(.*?)\]\(([^)]+\.(?:jpe?g|png|gif|webp|svg))\)/i.test(content) ||
    /<img\s+[^>]*src="([^"]+\.(?:jpe?g|png|gif|webp|svg))"[^>]*>/i.test(content)
  );
};

const normalizeVaultPath = (value: string): string => {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
};

const processMarkdownImages = (
  content: string,
  _files: unknown[],
): { result: string; newImages: Map<string, string> } => {
  const newImages = new Map<string, string>();
  let result = content;

  result = result.replace(
    /!\[(.*?)\]\(([^)]+\.(?:jpe?g|png|gif|webp|svg))\)/gi,
    (match, altText: string, imageRef: string) => {
      if (!isImageFile(imageRef)) {
        return match;
      }
      const ext = getExtension(imageRef);
      const filenameNew = `${randomUUID()}.${ext}`;
      return `![${altText}](/uploads/${filenameNew})`;
    },
  );

  result = result.replace(
    /<img\s+([^>]*?)src="([^"]+\.(?:jpe?g|png|gif|webp|svg))"([^>]*)>/gi,
    (match, beforeSrc: string, imageRef: string, afterSrc: string) => {
      if (!isImageFile(imageRef)) {
        return match;
      }
      const ext = getExtension(imageRef);
      const filenameNew = `${randomUUID()}.${ext}`;
      return `<img ${beforeSrc}src="/uploads/${filenameNew}"${afterSrc}>`;
    },
  );

  return { result, newImages };
};

importRoute.post('/markdown', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  const parentId = c.req.query('parentId') || null;

  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    throw new HTTPException(400, { message: 'File is required' });
  }
  const file = formData.get('file');

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }

  if (!file.name.endsWith('.md')) {
    throw new HTTPException(400, { message: 'File must be a markdown file' });
  }

  const content = await file.text();

  const { title: frontmatterTitle, body, properties } = parseFrontmatter(content);
  const title = frontmatterTitle || file.name.replace(/\.md$/, '');

  await mkdir(uploadsDir, { recursive: true });

  const { result: processedContent } = processMarkdownImages(body, []);
  const contentForEditor = stripLeadingH1(processedContent, title);
  let ydocBuffer = Buffer.from(createYjsDocWithTitle(title, contentForEditor));

  // Resolve wiki link titles to page UUIDs so backlinks survive renames.
  const existingPages = await pool.query(
    'select id, title from pages where workspace_id = $1 and is_deleted = false',
    [workspaceId],
  );
  const pageLookup = new Map<string, string>();
  for (const row of existingPages.rows as { id: string; title: string }[]) {
    pageLookup.set(row.title.trim().toLowerCase(), row.id);
  }
  if (pageLookup.size > 0) {
    ydocBuffer = Buffer.from(resolveWikilinkTargets(ydocBuffer, pageLookup));
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2'
      : 'select max(position) as max_position from pages where workspace_id = $1 and parent_id is null',
    parentId ? [workspaceId, parentId] : [workspaceId],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const hasProperties = Object.keys(properties).length > 0;
  const insertResult = hasProperties
    ? await pool.query(
        "insert into pages (workspace_id, parent_id, title, title_search, position, created_by, ydoc, properties) values ($1, $2, $3, to_tsvector('english', $3), $4, $5, $6, $7) returning *",
        [
          workspaceId,
          parentId,
          title,
          nextPosition,
          user.id,
          ydocBuffer,
          JSON.stringify(properties),
        ],
      )
    : await pool.query(
        "insert into pages (workspace_id, parent_id, title, title_search, position, created_by, ydoc) values ($1, $2, $3, to_tsvector('english', $3), $4, $5, $6) returning *",
        [workspaceId, parentId, title, nextPosition, user.id, ydocBuffer],
      );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create page' });
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json(created, 201);
});

export default importRoute;
