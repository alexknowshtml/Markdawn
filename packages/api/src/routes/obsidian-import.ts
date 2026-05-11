import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeTagSlug } from '@markdawn/shared/yjs-helpers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import {
  markdownToYjsState,
  resolveWikilinkTargets,
  stripLeadingH1,
} from '../utils/markdown-to-yjs';
import {
  getExtension,
  isImageFile,
  isMarkdownFile,
  parseFrontmatter,
} from '../utils/obsidian-parsers';

const obsidianImportRoute = new Hono();
obsidianImportRoute.use('*', requireAuth);

// ── Types ───────────────────────────────────────────────────────────

type VaultFile = {
  path: string;
  content?: string;
  data?: string;
  mimeType?: string;
};

type ImportResult = {
  foldersCreated: number;
  pagesCreated: number;
  imagesUploaded: number;
  backlinksCreated: number;
  errors: string[];
};

// ── Helpers ─────────────────────────────────────────────────────────

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );
  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

/**
 * Extract wiki links from markdown content.
 */
const WIKILINK_REGEX = /(?<!!)\[\[([^#|\]]+)(?:#(\^[^|]+)|#([^|\]]+))?(?:\|([^\]]+))?\]\]/g;

interface WikilinkMatch {
  page: string;
  blockId: string | undefined;
  heading: string | undefined;
  alias: string | undefined;
  isEmbed: boolean;
}

const extractWikilinks = (content: string): WikilinkMatch[] => {
  const results: WikilinkMatch[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const page = match[1];
    if (!page) continue;
    results.push({
      page: page.trim(),
      blockId: match[2]?.trim(),
      heading: match[3]?.trim(),
      alias: match[4]?.trim(),
      isEmbed: false,
    });
  }
  return results;
};

const extractEmbedLinks = (content: string): WikilinkMatch[] => {
  const embedRegex = /!\[\[([^#|\]]+)(?:#(\^[^|]+)|#([^|\]]+))?(?:\|([^\]]+))?\]\]/g;
  const results: WikilinkMatch[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
  while ((match = embedRegex.exec(content)) !== null) {
    const page = match[1];
    if (!page) continue;
    results.push({
      page: page.trim(),
      blockId: match[2]?.trim(),
      heading: match[3]?.trim(),
      alias: match[4]?.trim(),
      isEmbed: true,
    });
  }
  return results;
};

const extractInlineTags = (content: string): string[] => {
  const tags = new Set<string>();
  const hexOnly = /^[0-9a-fA-F]+$/;
  const inlineTags = content.matchAll(/(?:^|\s)#([a-zA-Z0-9_\-\/]+)/g);

  for (const match of inlineTags) {
    const rawTag = match[1];
    if (!rawTag) continue;
    if (
      hexOnly.test(rawTag) &&
      (rawTag.length === 3 || rawTag.length === 6 || rawTag.length === 8)
    ) {
      continue;
    }
    const slug = normalizeTagSlug(rawTag);
    if (slug) tags.add(slug);
  }

  return [...tags];
};

const processMarkdownContent = (content: string, imageMap: Map<string, string>): string => {
  let result = content;

  result = result.replace(
    /!\[\[([^\]|]+(?:\.jpe?g|\.png|\.gif|\.webp|\.svg))(?:\|([^\]]+))?\]\]/gi,
    (match, imagePath: string) => {
      const normalizedPath = imagePath.replace(/\\/g, '/').trim();
      const uploadedUrl = imageMap.get(normalizedPath);
      if (uploadedUrl) {
        return `![${path.basename(normalizedPath)}](${uploadedUrl})`;
      }
      return `![${path.basename(normalizedPath)}](${normalizedPath})`;
    },
  );

  result = result.replace(/!\[\[([^\]]+)\]\]/g, (match, filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/').trim();
    return `[${path.basename(normalized)}](${normalized})`;
  });

  return result;
};

// ── Route Handler ───────────────────────────────────────────────────

obsidianImportRoute.post('/', async (c) => {
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  const user = c.get('user') as { id: string };
  await ensureWorkspaceMember(workspaceId, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { files } = body as { files?: VaultFile[] };
  if (!Array.isArray(files) || files.length === 0) {
    throw new HTTPException(400, { message: 'files array is required' });
  }

  const result: ImportResult = {
    foldersCreated: 0,
    pagesCreated: 0,
    imagesUploaded: 0,
    backlinksCreated: 0,
    errors: [],
  };

  const hasPropertiesColumn = await pool
    .query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'properties' LIMIT 1`,
    )
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);

  const hasConnectionsTable = await pool
    .query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'connections' LIMIT 1`)
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);

  const markdownFiles: VaultFile[] = [];
  const imageFiles: VaultFile[] = [];

  for (const file of files) {
    const fileName = path.basename(file.path);
    if (isMarkdownFile(fileName)) {
      markdownFiles.push(file);
    } else if (isImageFile(fileName) && file.data) {
      imageFiles.push(file);
    }
  }

  const folderPathToId = new Map<string, string>();
  const uniqueDirs = new Set<string>();

  for (const file of files) {
    const dir = path.dirname(file.path);
    if (dir !== '.' && dir !== '/') {
      const parts = dir.split(/[\\/]/).filter(Boolean);
      let currentPath = '';
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        uniqueDirs.add(currentPath);
      }
    }
  }

  const sortedDirs = Array.from(uniqueDirs).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    return depthA - depthB;
  });

  for (const dirPath of sortedDirs) {
    try {
      const parts = dirPath.split('/');
      const name = parts[parts.length - 1] ?? '';
      const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
      const parentId = parentPath ? (folderPathToId.get(parentPath) ?? null) : null;

      const positionResult = await pool.query(
        parentId
          ? 'select max(position) as max_position from folders where workspace_id = $1 and parent_id = $2'
          : 'select max(position) as max_position from folders where workspace_id = $1 and parent_id is null',
        parentId ? [workspaceId, parentId] : [workspaceId],
      );
      const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

      const insertResult = await pool.query(
        'insert into folders (workspace_id, parent_id, name, position, created_by) values ($1, $2, $3, $4, $5) returning id',
        [workspaceId, parentId, name, nextPosition, user.id],
      );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        folderPathToId.set(dirPath, insertResult.rows[0]?.id);
        result.foldersCreated++;
      }
    } catch (err) {
      result.errors.push(`Failed to create folder "${dirPath}": ${(err as Error).message}`);
    }
  }

  const imagePathToUrl = new Map<string, string>();
  const uploadDir = path.resolve('uploads');
  await mkdir(uploadDir, { recursive: true });

  for (const file of imageFiles) {
    try {
      if (!file.data || !file.mimeType) continue;

      const ext = getExtension(file.path);
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(uploadDir, filename);
      const buffer = Buffer.from(file.data, 'base64');
      await writeFile(filePath, buffer);

      await pool.query(
        `insert into uploads (filename, original_name, mime_type, size, workspace_id, uploaded_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [filename, path.basename(file.path), file.mimeType, buffer.length, workspaceId, user.id],
      );

      const url = `/api/uploads/${filename}`;
      imagePathToUrl.set(file.path, url);
      imagePathToUrl.set(path.basename(file.path), url);
      const parts = file.path.split('/');
      if (parts.length > 2) {
        const withoutRoot = parts.slice(1).join('/');
        imagePathToUrl.set(withoutRoot, url);
      }
      result.imagesUploaded++;
    } catch (err) {
      result.errors.push(`Failed to upload image "${file.path}": ${(err as Error).message}`);
    }
  }

  const pageTitleToId = new Map<string, string>();
  const pagePathToId = new Map<string, string>();
  const pageYdocs = new Map<string, Buffer>();

  for (const file of markdownFiles) {
    try {
      if (!file.content) continue;

      const { frontmatter, body, tags, title: frontmatterTitle } = parseFrontmatter(file.content);
      const fileName = path.basename(file.path, '.md');
      const title = frontmatterTitle || fileName;

      const dir = path.dirname(file.path);
      const parentId =
        dir !== '.' && dir !== '/' ? (folderPathToId.get(dir.replace(/\\/g, '/')) ?? null) : null;

      const processedBody = processMarkdownContent(body, imagePathToUrl);
      const contentForEditor = stripLeadingH1(processedBody, title);
      const ydocBuffer = Buffer.from(markdownToYjsState(contentForEditor));
      // Store for deferred targetId resolution after all pages are known
      pageYdocs.set(file.path, ydocBuffer);

      const positionResult = await pool.query(
        parentId
          ? 'select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2'
          : 'select max(position) as max_position from pages where workspace_id = $1 and parent_id is null',
        parentId ? [workspaceId, parentId] : [workspaceId],
      );
      const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

      const insertResult = hasPropertiesColumn
        ? await pool.query(
            `insert into pages (workspace_id, parent_id, title, title_search, position, created_by, ydoc, properties)
             values ($1, $2, $3, to_tsvector('english', $3), $4, $5, $6, $7) returning *`,
            [
              workspaceId,
              parentId,
              title,
              nextPosition,
              user.id,
              ydocBuffer,
              JSON.stringify(frontmatter),
            ],
          )
        : await pool.query(
            `insert into pages (workspace_id, parent_id, title, title_search, position, created_by, ydoc)
             values ($1, $2, $3, to_tsvector('english', $3), $4, $5, $6) returning *`,
            [workspaceId, parentId, title, nextPosition, user.id, ydocBuffer],
          );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        const pageId = insertResult.rows[0]?.id;
        pageTitleToId.set(title.toLowerCase(), pageId);
        pagePathToId.set(file.path, pageId);

        const pageTagSlugs = new Set([
          ...tags.map((tag) => normalizeTagSlug(tag)).filter(Boolean),
          ...extractInlineTags(file.content),
        ]);

        for (const tagSlug of pageTagSlugs) {
          await pool.query(
            `insert into connections (
               workspace_id, source_type, source_id, target_type, target_slug,
               target_label, connection_type, link_text, occurrence_count, updated_at
             )
             values ($1, 'page', $2, 'tag', $3, $3, 'tag', $3, 1, now())
             on conflict (workspace_id, source_type, source_id, target_type, target_slug, connection_type)
             do update set updated_at = now(), occurrence_count = excluded.occurrence_count`,
            [workspaceId, pageId, tagSlug],
          );
        }

        result.pagesCreated++;
      }
    } catch (err) {
      result.errors.push(`Failed to create page "${file.path}": ${(err as Error).message}`);
    }
  }

  if (hasConnectionsTable) {
    for (const file of markdownFiles) {
      try {
        if (!file.content) continue;

        const pageId = pagePathToId.get(file.path);
        if (!pageId) continue;

        const wikilinks = extractWikilinks(file.content);
        const embeds = extractEmbedLinks(file.content);
        const allLinks = [...wikilinks, ...embeds];

        for (const link of allLinks) {
          if (link.isEmbed && isImageFile(link.page)) continue;

          const targetTitleLower = link.page.toLowerCase();
          const targetPageId = pageTitleToId.get(targetTitleLower) ?? null;
          const connectionType = link.isEmbed ? 'embed' : link.heading ? 'heading' : 'wikilink';

          await pool.query(
            `insert into connections (
               workspace_id, source_type, source_id, target_type, target_id, target_slug,
               target_label, connection_type, link_text, occurrence_count, updated_at
             )
             values ($1, 'page', $2, 'page', $3, $4, $5, $6, $7, 1, now())
             on conflict (workspace_id, source_type, source_id, target_type, target_slug, connection_type)
             do update set
               target_id = excluded.target_id,
               target_label = excluded.target_label,
               link_text = excluded.link_text,
               occurrence_count = connections.occurrence_count + 1,
               updated_at = now()`,
            [
              workspaceId,
              pageId,
              targetPageId,
              targetTitleLower,
              link.page,
              connectionType,
              link.alias || link.page,
            ],
          );

          if (targetPageId) {
            result.backlinksCreated++;
          }
        }
      } catch (err) {
        result.errors.push(
          `Failed to index backlinks for "${file.path}": ${(err as Error).message}`,
        );
      }
    }
  }

  // Resolve wiki link targetId in Yjs binaries now that pageTitleToId
  // contains every page created during the import.
  if (pageTitleToId.size > 0) {
    for (const [filePath, pageId] of pagePathToId) {
      const rawYdoc = pageYdocs.get(filePath);
      if (!rawYdoc) continue;
      const resolved = resolveWikilinkTargets(rawYdoc, pageTitleToId);
      await pool.query('update pages set ydoc = $1 where id = $2', [Buffer.from(resolved), pageId]);
    }
  }

  return c.json(result, 201);
});

export default obsidianImportRoute;
