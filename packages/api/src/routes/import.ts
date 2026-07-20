import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import { getDestinationOwnerId } from '../utils/destinationOwner';
import { ensureDocumentInputSize, ensureYdocSize } from '../utils/documentSize';
import {
  bindWikiLinkTargets,
  createYjsDocWithTitle,
  stripLeadingH1,
} from '../utils/markdown-to-yjs';
import { normalizePageRow, type PageDatabaseRow } from '../utils/pageRows';
import { normalizePageTitle } from '../utils/pageTitle';
import { getNextPosition } from '../utils/position';
import {
  ensureFolderAccess,
  lockEntityAccessMutation,
  lockWorkspaceAccessMutation,
} from '../utils/share-access';
import { notifyShareRecompute } from '../utils/share-notify';
import { getEntityMetaUserIds } from '../utils/shareRecipients';
import { getUniqueWorkspacePageLookup } from '../utils/wiki-link-lookup';

const ALLOWED_IMAGE_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp']);

const importRoute = new Hono();

importRoute.use('*', requireAuth);

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

const _containsImageReferences = (content: string): boolean => {
  return (
    /!\[\[([^\]]+\.(?:jpe?g|png|gif|webp|svg))\]\]/i.test(content) ||
    /\[\[([^\]]+\.(?:jpe?g|png|gif|webp|svg))\]\]/i.test(content) ||
    /!\[(.*?)\]\(([^)]+\.(?:jpe?g|png|gif|webp|svg))\)/i.test(content) ||
    /<img\s+[^>]*src="([^"]+\.(?:jpe?g|png|gif|webp|svg))"[^>]*>/i.test(content)
  );
};

const _normalizeVaultPath = (value: string): string => {
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
  const parentId = c.req.query('parentId') || null;

  const user = c.get('user') as { id: string };

  if (parentId) {
    await ensureFolderAccess(parentId, user.id, 'admin');
  }

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

  ensureDocumentInputSize(file);
  const content = await file.text();

  const { title: frontmatterTitle, body, properties } = parseFrontmatter(content);
  const title = normalizePageTitle(frontmatterTitle || file.name.replace(/\.md$/, ''));

  await mkdir(uploadsDir, { recursive: true });

  const { result: processedContent } = processMarkdownImages(body, []);
  const contentForEditor = stripLeadingH1(processedContent, title);
  const unresolvedYdocBuffer = Buffer.from(createYjsDocWithTitle(title, contentForEditor));
  ensureYdocSize(unresolvedYdocBuffer);

  const hasProperties = Object.keys(properties).length > 0;
  const insertResult = await db.transaction(async (tx) => {
    if (parentId) {
      await lockEntityAccessMutation(tx, 'folder', parentId);
      await ensureFolderAccess(parentId, user.id, 'admin', tx);
    } else {
      await lockWorkspaceAccessMutation(tx, user.id);
    }

    const ownerId = await getDestinationOwnerId(tx, parentId, user.id);
    if (!ownerId) throw new HTTPException(404, { message: 'Parent folder not found' });
    const pageLookup = await getUniqueWorkspacePageLookup(ownerId, user.id, tx);
    const ydocBuffer = Buffer.from(bindWikiLinkTargets(unresolvedYdocBuffer, pageLookup));
    ensureYdocSize(ydocBuffer);

    const nextPosition = await getNextPosition('pages', parentId, user.id, tx);
    const result = hasProperties
      ? await executeQuery<PageDatabaseRow>(
          tx,
          sql`insert into pages (parent_id, title, title_search, position, created_by, ydoc, properties) values (${parentId}, ${title}, to_tsvector('english', ${title}), ${nextPosition}, ${user.id}, ${ydocBuffer}, ${JSON.stringify(properties)}) returning *`,
        )
      : await executeQuery<PageDatabaseRow>(
          tx,
          sql`insert into pages (parent_id, title, title_search, position, created_by, ydoc) values (${parentId}, ${title}, to_tsvector('english', ${title}), ${nextPosition}, ${user.id}, ${ydocBuffer}) returning *`,
        );
    const createdPageId = result.rows[0]?.id;
    if (createdPageId) {
      const metaUserIds = await getEntityMetaUserIds(tx, 'page', createdPageId);
      await notifyShareRecompute(
        {
          entityType: 'page',
          entityId: createdPageId,
          metaUserIds,
          metaOnly: true,
        },
        tx,
      );
    }
    return { result, ownerId };
  });

  if (insertResult.result.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create page' });
  }

  const createdRow = insertResult.result.rows[0];
  if (!createdRow) throw new HTTPException(500, { message: 'Failed to create page' });
  const created = normalizePageRow(createdRow, insertResult.ownerId);
  return c.json(created, 201);
});

export default importRoute;
