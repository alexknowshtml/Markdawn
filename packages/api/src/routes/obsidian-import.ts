import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { markdownToYjsState, stripLeadingH1 } from '../utils/markdown-to-yjs';

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
  tagsCreated: number;
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

const getExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
};

const ALLOWED_IMAGE_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp', 'svg']);

const isImageFile = (filename: string): boolean => {
  return ALLOWED_IMAGE_TYPES.has(getExtension(filename));
};

const isMarkdownFile = (filename: string): boolean => {
  return filename.endsWith('.md');
};

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the frontmatter object, the body without frontmatter, and extracted tags.
 */
const parseFrontmatter = (
  content: string,
): { frontmatter: Record<string, unknown>; body: string; tags: string[]; title: string } => {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    const title = h1Match?.[1]?.trim() ?? '';
    return { frontmatter: {}, body: content, tags: [], title };
  }

  const frontmatterBlock = match[1] ?? '';
  const body = content.slice(match[0]?.length);

  const frontmatter: Record<string, unknown> = {};
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
      frontmatter[currentKey] = currentArray;
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
        frontmatter[currentKey] = value
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''));
      } else {
        frontmatter[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (inArray && currentKey) {
    frontmatter[currentKey] = currentArray;
  }

  let title = '';
  const titleValue = frontmatter.title;
  if (typeof titleValue === 'string') {
    title = titleValue;
  }

  const tags: string[] = [];
  const tagValue = frontmatter.tags;
  if (Array.isArray(tagValue)) {
    tags.push(...tagValue.filter((t): t is string => typeof t === 'string'));
  } else if (typeof tagValue === 'string') {
    tags.push(
      ...tagValue
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }

  return { frontmatter, body, tags, title };
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
    tagsCreated: 0,
    backlinksCreated: 0,
    errors: [],
  };

  const hasPropertiesColumn = await pool
    .query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'properties' LIMIT 1`,
    )
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);

  const hasTagsTable = await pool
    .query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'tags' LIMIT 1`)
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => false);

  const hasPageLinksTable = await pool
    .query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'page_links' LIMIT 1`)
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

  const tagNameToId = new Map<string, string>();
  const allTags = new Set<string>();

  if (hasTagsTable) {
    for (const file of markdownFiles) {
      if (!file.content) continue;
      const { tags } = parseFrontmatter(file.content);
      for (const tag of tags) {
        allTags.add(tag.toLowerCase().trim());
      }

      // Extract inline #tags from markdown body (same logic as frontend preview)
      const HEX_ONLY = /^[0-9a-fA-F]+$/;
      const inlineTags = file.content.matchAll(/(?:^|\s)#([a-zA-Z0-9_\-\/]+)/g);
      for (const match of inlineTags) {
        const rawTag = match[1];
        if (!rawTag) continue;
        if (
          HEX_ONLY.test(rawTag) &&
          (rawTag.length === 3 || rawTag.length === 6 || rawTag.length === 8)
        ) {
          continue;
        }
        allTags.add(rawTag.toLowerCase().trim());
      }
    }

    for (const tagName of allTags) {
      try {
        const existing = await pool.query(
          'select id from tags where workspace_id = $1 and name = $2 limit 1',
          [workspaceId, tagName],
        );

        if (existing.rowCount && existing.rowCount > 0) {
          tagNameToId.set(tagName, existing.rows[0]?.id);
        } else {
          const insertResult = await pool.query(
            'insert into tags (workspace_id, name) values ($1, $2) returning id',
            [workspaceId, tagName],
          );
          if (insertResult.rowCount && insertResult.rowCount > 0) {
            tagNameToId.set(tagName, insertResult.rows[0]?.id);
            result.tagsCreated++;
          }
        }
      } catch (err) {
        result.errors.push(`Failed to create tag "${tagName}": ${(err as Error).message}`);
      }
    }
  }

  const pageTitleToId = new Map<string, string>();
  const pagePathToId = new Map<string, string>();

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

      const positionResult = await pool.query(
        parentId
          ? 'select max(position) as max_position from pages where workspace_id = $1 and parent_id = $2'
          : 'select max(position) as max_position from pages where workspace_id = $1 and parent_id is null',
        parentId ? [workspaceId, parentId] : [workspaceId],
      );
      const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

      const insertResult = hasPropertiesColumn
        ? await pool.query(
            `insert into pages (workspace_id, parent_id, title, position, created_by, ydoc, properties)
             values ($1, $2, $3, $4, $5, $6, $7) returning *`,
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
            `insert into pages (workspace_id, parent_id, title, position, created_by, ydoc)
             values ($1, $2, $3, $4, $5, $6) returning *`,
            [workspaceId, parentId, title, nextPosition, user.id, ydocBuffer],
          );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        const pageId = insertResult.rows[0]?.id;
        pageTitleToId.set(title.toLowerCase(), pageId);
        pagePathToId.set(file.path, pageId);

        if (hasTagsTable) {
          for (const tag of tags) {
            const tagId = tagNameToId.get(tag.toLowerCase().trim());
            if (tagId) {
              await pool
                .query(
                  'insert into page_tags (page_id, tag_id) values ($1, $2) on conflict do nothing',
                  [pageId, tagId],
                )
                .catch(() => {});
            }
          }
        }

        result.pagesCreated++;
      }
    } catch (err) {
      result.errors.push(`Failed to create page "${file.path}": ${(err as Error).message}`);
    }
  }

  if (hasPageLinksTable) {
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

          await pool.query(
            `insert into page_links (source_page_id, target_page_id, target_title, link_text, link_type)
             values ($1, $2, $3, $4, $5)
             on conflict (source_page_id, target_title) do update set
               target_page_id = excluded.target_page_id,
               link_text = excluded.link_text,
               link_type = excluded.link_type`,
            [
              pageId,
              targetPageId,
              link.page,
              link.alias || link.page,
              link.isEmbed ? 'embed' : link.heading ? 'heading' : 'wiki',
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

  return c.json(result, 201);
});

export default obsidianImportRoute;
