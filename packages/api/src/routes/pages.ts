import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import JSZip from 'jszip';
import { marked } from 'marked';
import * as Y from 'yjs';
import { auth } from '../auth';
import type { pages } from '../db';
import { pool } from '../db/connection';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import { extractImages, pageToMarkdown } from '../utils/export-helpers';
import { slugifyFilename } from '../utils/filename';
import {
  createEmptyYjsDoc,
  createYjsDocWithTitle,
  resolveWikilinkTargets,
} from '../utils/markdown-to-yjs';
import { ensureCanManageEntity, ensureFolderAccess, ensurePageAccess } from '../utils/share-access';

type PageRow = typeof pages.$inferSelect;
type RawPageRow = PageRow & {
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  is_deleted?: boolean | null;
  deleted_at?: Date | null;
  is_public?: boolean | null;
  public_token?: string | null;
};

const pagesRoute = new Hono();
const pagesPublicRoute = new Hono();

pagesRoute.use('*', requireAuth);

const _markdownToHtml = (markdown: string): string => {
  return marked.parse(markdown, { async: false }) as string;
};

const isValidMarkdown = (markdown: string): boolean => {
  try {
    marked.parse(markdown, { async: false });
    return true;
  } catch {
    return false;
  }
};

const getPageById = async (pageId: string) => {
  const result = await pool.query('select * from pages where id = $1 limit 1', [pageId]);
  const row = (result.rows[0] as RawPageRow | undefined) ?? null;
  return row ? normalizePageRow(row) : null;
};

const normalizePageRow = (row: RawPageRow): PageRow => ({
  ...row,
  parentId: row.parentId ?? row.parent_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
  isDeleted: row.isDeleted ?? row.is_deleted ?? false,
  deletedAt: row.deletedAt ?? row.deleted_at ?? null,
  isPublic: row.isPublic ?? row.is_public ?? false,
  publicToken: row.publicToken ?? row.public_token ?? null,
});

pagesRoute.get('/tree', async (c) => {
  // Return pages the user can access (owned or shared)
  const user = c.get('user') as { id: string };

  const result = await pool.query(
    `
      with recursive shared_folders as (
        select f.id
        from shares s
        join folders f on f.id = s.entity_id
        where s.entity_type = 'folder' and s.recipient_user_id = $1 and f.is_deleted = false
        union all
        select child.id
        from folders child
        join shared_folders parent on child.parent_id = parent.id
        where child.is_deleted = false
      )
      select p.*
      from pages p
      where p.is_deleted = false
        and (
          p.created_by = $1
          or exists (
            select 1 from shares s
            where s.entity_type = 'page' and s.entity_id = p.id and s.recipient_user_id = $1
          )
          or p.parent_id in (select id from shared_folders)
        )
      order by p.parent_id nulls first, case when p.parent_id is null then p.updated_at end desc nulls last, p.position asc
    `,
    [user.id],
  );

  const pagesList = (result.rows as RawPageRow[]).map(normalizePageRow);
  return c.json(
    pagesList.map((page) => ({
      ...page,
      ydoc: page.ydoc ? Array.from(page.ydoc) : null,
      children: [],
    })),
  );
});

pagesRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, title, icon } = body as {
    parentId?: string | null;
    title?: string;
    icon?: string | null;
  };

  const user = c.get('user') as { id: string };

  if (parentId) {
    const folderResult = await pool.query(
      'select id from folders where id = $1 and is_deleted = false limit 1',
      [parentId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    // ensure user can manage parent
    await ensureFolderAccess(parentId, user.id, 'edit');
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from pages where parent_id = $1 and created_by = $2'
      : 'select max(position) as max_position from pages where parent_id is null and created_by = $1',
    parentId ? [parentId, user.id] : [user.id],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const pageTitle =
    typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Untitled';

  const ydocBuffer = Buffer.from(createEmptyYjsDoc(pageTitle));

  const insertResult = await pool.query(
    "insert into pages (parent_id, title, title_search, icon, position, created_by, ydoc) values ($1, $2, to_tsvector('english', $2), $3, $4, $5, $6) returning *",
    [
      parentId ?? null,
      pageTitle,
      typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
      nextPosition,
      user.id,
      ydocBuffer,
    ],
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create page' });
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.get('/trash', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await pool.query(
    'select * from pages where is_deleted = true and created_by = $1 order by deleted_at desc nulls last, position asc',
    [user.id],
  );

  return c.json((result.rows as RawPageRow[]).map(normalizePageRow));
});

pagesRoute.delete('/trash/empty-all', async (c) => {
  const user = c.get('user') as { id: string };

  const userPages = await pool.query(
    'select id, parent_id, is_deleted from pages where created_by = $1',
    [user.id],
  );

  const childMap = new Map<string, string[]>();
  const trashedPageIds = new Set<string>();

  for (const item of userPages.rows as {
    id: string;
    parent_id: string | null;
    is_deleted: boolean;
  }[]) {
    if (item.is_deleted) {
      trashedPageIds.add(item.id);
    }
    if (!item.parent_id) {
      continue;
    }
    const list = childMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childMap.set(item.parent_id, list);
  }

  const toDelete = new Set<string>();
  const stack = Array.from(trashedPageIds);
  while (stack.length) {
    const current = stack.pop();
    if (!current || toDelete.has(current)) {
      continue;
    }
    toDelete.add(current);
    const children = childMap.get(current);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  if (toDelete.size > 0) {
    await pool.query('delete from pages where id = any($1)', [Array.from(toDelete)]);
  }

  return c.json({ deleted: true, count: toDelete.size });
});

pagesRoute.get('/recent', async (c) => {
  const limitParam = c.req.query('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 10;
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    throw new HTTPException(400, { message: 'limit must be a positive integer' });
  }

  const user = c.get('user') as { id: string };

  const result = await pool.query(
    'select p.id, p.title, p.icon, pv.visited_at as "visitedAt" from page_visits pv join pages p on p.id = pv.page_id where pv.user_id = $1 and p.is_deleted = false order by pv.visited_at desc limit $2',
    [user.id, parsedLimit],
  );

  return c.json(
    result.rows as { id: string; title: string; icon: string | null; visitedAt: Date }[],
  );
});

pagesPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    const pageId = c.req.param('id');
    const page = await getPageById(pageId);

    if (!page) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const user = session.user as { id: string };
      if (!page.isPublic) {
        await ensurePageAccess(page.id, user.id);
      }
      await pool.query(
        'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
        [user.id, pageId],
      );
    } else if (!page.isPublic) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    // Determine if a link share exists and expose its permission to anonymous viewers.
    const linkResult = await pool.query(
      "select permission from shares where entity_type = 'page' and entity_id = $1 and token is not null limit 1",
      [pageId],
    );
    const linkRow = linkResult.rows[0] as { permission: string } | undefined;
    const linkPermission = linkRow ? (linkRow.permission as 'view' | 'edit') : null;

    return c.json({ ...page, ydoc: page.ydoc ? Array.from(page.ydoc) : null, linkPermission });
  },
);

pagesRoute.post(':id/access', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  if (!page.isPublic) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };

  const shareResult = await pool.query(
    "SELECT token, permission FROM shares WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL LIMIT 1",
    [pageId],
  );
  const shareRow = shareResult.rows[0] as { token: string; permission: string } | undefined;
  const shareToken = shareRow?.token ?? pageId;
  const sharePermission = (shareRow?.permission ?? 'view') as 'view' | 'edit';

  await pool.query(
    `
      insert into page_access_events (page_id, user_id, source, token, permission, first_seen_at, last_seen_at)
      values ($1, $2, 'link', $3, $4, now(), now())
      on conflict (page_id, user_id, source, token)
      do update set permission = excluded.permission, last_seen_at = now()
    `,
    [page.id, user.id, shareToken, sharePermission],
  );

  return c.json({ ok: true });
});

pagesRoute.patch(':id/restore', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  // Direct ownership check — ensurePageAccess filters by is_deleted=false,
  // but restore operates on a soft-deleted page
  const ownerRes = await pool.query('select created_by from pages where id = $1 limit 1', [pageId]);
  const ownerRow = ownerRes.rows[0] as { created_by?: string } | undefined;
  if (!ownerRow || ownerRow.created_by !== user.id) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }

  const updateResult = await pool.query(
    "update pages set is_deleted = false, deleted_at = null, title_search = to_tsvector('english', title), updated_at = now() where id = $1 returning *",
    [pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to restore page' });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(':id', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(page.id, user.id, 'edit');

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { title, icon, parentId, position, coverType, coverValue, properties } = body as {
    title?: string;
    icon?: string | null;
    parentId?: string | null;
    position?: string | number;
    coverType?: string | null;
    coverValue?: string | null;
    properties?: Record<string, unknown> | null;
  };

  const hasParentId = Object.hasOwn(body, 'parentId');
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const folderResult = await pool.query(
      'select id from folders where id = $1 and is_deleted = false limit 1',
      [parentId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const nextTitle =
    typeof title === 'string' ? (title.trim().length > 0 ? title.trim() : 'Untitled') : page.title;

  const nextIcon =
    typeof icon === 'string'
      ? icon.trim().length > 0
        ? icon.trim()
        : null
      : icon === null
        ? null
        : page.icon;
  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition =
    typeof position === 'string'
      ? position.trim().length > 0
        ? position.trim()
        : page.position
      : typeof position === 'number' && Number.isFinite(position)
        ? String(position)
        : page.position;
  const hasCoverType = Object.hasOwn(body, 'coverType');
  const hasCoverValue = Object.hasOwn(body, 'coverValue');
  const hasProperties = Object.hasOwn(body, 'properties');
  const nextCoverType = hasCoverType
    ? typeof coverType === 'string' && coverType.trim().length > 0
      ? coverType.trim()
      : null
    : page.coverType;
  const nextCoverValue = hasCoverValue
    ? typeof coverValue === 'string' && coverValue.trim().length > 0
      ? coverValue.trim()
      : null
    : page.coverValue;
  const nextProperties = hasProperties
    ? properties && typeof properties === 'object'
      ? JSON.stringify(properties)
      : null
    : page.properties;

  const updateResult = hasProperties
    ? await pool.query(
        "update pages set title = $1, title_search = to_tsvector('english', $1), icon = $2, parent_id = $3, position = $4, cover_type = $5, cover_value = $6, properties = $7, updated_at = now() where id = $8 returning *",
        [
          nextTitle,
          nextIcon,
          nextParent,
          nextPosition,
          nextCoverType,
          nextCoverValue,
          nextProperties,
          pageId,
        ],
      )
    : await pool.query(
        "update pages set title = $1, title_search = to_tsvector('english', $1), icon = $2, parent_id = $3, position = $4, cover_type = $5, cover_value = $6, updated_at = now() where id = $7 returning *",
        [nextTitle, nextIcon, nextParent, nextPosition, nextCoverType, nextCoverValue, pageId],
      );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to update page' });
  }

  // Notify the collab server so it can update the meta room sidebar and
  // push the new title into any active in-memory Yjs session.
  if (page.title !== nextTitle) {
    await pool.query('select pg_notify($1, $2)', [
      'page_renamed',
      JSON.stringify({ pageId, newTitle: nextTitle }),
    ]);
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.patch(':id/move', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, position } = body as {
    parentId?: string | null;
    position?: string | number;
  };

  const hasParentId = Object.hasOwn(body, 'parentId');
  if (hasParentId && parentId) {
    if (parentId === page.id) {
      throw new HTTPException(400, { message: 'Cannot set parent to self' });
    }
    const folderResult = await pool.query(
      'select id from folders where id = $1 and is_deleted = false limit 1',
      [parentId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const nextParent = hasParentId ? (parentId ?? null) : page.parentId;
  const nextPosition =
    typeof position === 'string'
      ? position.trim().length > 0
        ? position.trim()
        : page.position
      : typeof position === 'number' && Number.isFinite(position)
        ? String(position)
        : page.position;

  const updateResult = await pool.query(
    'update pages set parent_id = $1, position = $2, updated_at = now() where id = $3 returning *',
    [nextParent, nextPosition, pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to move page' });
  }

  const updated = normalizePageRow(updateResult.rows[0] as RawPageRow);
  return c.json({ ...updated, ydoc: updated.ydoc ? Array.from(updated.ydoc) : null });
});

pagesRoute.get(':id/export/markdown', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const baseFilename = slugifyFilename(page.title || 'Untitled') || 'untitled';
  const markdown = pageToMarkdown(page.ydoc, page.properties, page.icon, page.title || undefined);
  const extracted = await extractImages(markdown, uploadsDir);

  if (extracted.assets.size === 0) {
    c.header('Content-Type', 'text/markdown');
    c.header('Content-Disposition', `attachment; filename="${baseFilename}.md"`);
    return c.body(extracted.markdown);
  }

  const zip = new JSZip();
  zip.file(`${baseFilename}.md`, extracted.markdown);
  for (const [assetName, assetBuffer] of extracted.assets) {
    zip.file(`assets/${assetName}`, assetBuffer);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${baseFilename}.zip"`);
  return c.newResponse(arrayBuffer, 200);
});

pagesRoute.post(':id/import/markdown', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const contentType = c.req.header('content-type') ?? '';
  let markdown = '';

  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Invalid body' });
    }
    const bodyMarkdown = (body as { markdown?: string }).markdown;
    markdown = typeof bodyMarkdown === 'string' ? bodyMarkdown : '';
  } else if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: 'File is required' });
    }
    markdown = await file.text();
  } else {
    throw new HTTPException(415, { message: 'Unsupported content type' });
  }

  if (!markdown.trim()) {
    throw new HTTPException(400, { message: 'Markdown is required' });
  }

  if (!isValidMarkdown(markdown)) {
    throw new HTTPException(400, { message: 'Invalid markdown format' });
  }

  // Build Yjs doc with both title and body content
  // Title and H1 are independent — we don't strip the first H1 anymore
  let ydocBuffer = Buffer.from(createYjsDocWithTitle(page.title || 'Untitled', markdown));

  // Resolve wiki link titles to page UUIDs so backlinks survive renames.
  {
    const existingPages = await pool.query(
      'select id, title from pages where is_deleted = false',
      [],
    );
    const pageLookup = new Map<string, string>();
    for (const row of existingPages.rows as { id: string; title: string }[]) {
      pageLookup.set(row.title.trim().toLowerCase(), row.id);
    }
    if (pageLookup.size > 0) {
      ydocBuffer = Buffer.from(resolveWikilinkTargets(ydocBuffer, pageLookup));
    }
  }

  const updateResult = await pool.query(
    "update pages set ydoc = $1, title = $2, title_search = to_tsvector('english', $2), updated_at = now() where id = $3",
    [ydocBuffer, page.title || 'Untitled', pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to import page content' });
  }

  return c.json({ success: true });
});

pagesRoute.delete(':id', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const updateResult = await pool.query(
    'update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
    [pageId],
  );

  if (updateResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to delete page' });
  }

  // Notify the collab server so it removes the page from the meta room.
  await pool.query('select pg_notify($1, $2)', ['page_deleted', JSON.stringify({ pageId })]);

  return c.json({ deleted: true });
});

pagesRoute.post(':id/copy', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;

  if (parentId) {
    const folderResult = await pool.query(
      'select id from folders where id = $1 and is_deleted = false limit 1',
      [parentId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
  }

  const positionResult = await pool.query(
    parentId
      ? 'select max(position) as max_position from pages where parent_id = $1 and is_deleted = false and created_by = $2'
      : 'select max(position) as max_position from pages where parent_id is null and is_deleted = false and created_by = $1',
    parentId ? [parentId, user.id] : [user.id],
  );
  const nextPosition = (Number(positionResult.rows[0]?.max_position ?? -1) || -1) + 1;

  const insertResult = await pool.query(
    `insert into pages (id, parent_id, title, title_search, icon, cover_type, cover_value, position, ydoc, created_by)
     select gen_random_uuid(), $1, $2, to_tsvector('english', $2), icon, cover_type, cover_value, $3, ydoc, $4
     from pages where id = $5
     returning id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by, created_at, updated_at, is_deleted`,
    [parentId ?? null, `Copy of ${page.title}`, nextPosition, user.id, pageId],
  );

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to copy page' });
  }

  const copiedPage = insertResult.rows[0] as RawPageRow;
  const newPageId = copiedPage.id;

  if (page.ydoc && page.ydoc.length > 0) {
    try {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(page.ydoc));
      const titleText = ydoc.getText('title');
      if (titleText.length > 0) {
        titleText.delete(0, titleText.length);
      }
      titleText.insert(0, `Copy of ${page.title}`);
      const newBinary = Buffer.from(Y.encodeStateAsUpdate(ydoc));
      await pool.query('update pages set ydoc = $1 where id = $2', [newBinary, newPageId]);
    } catch {
      // If Yjs decode fails, the title column is already set
    }
  }

  // Copy connections from the original page so wiki links and tags
  // appear immediately — without this, the copied page's backlinks
  // panel and tag queries would be empty until a user opens it and
  // triggers a collab persist.
  {
    const originalConnections = await pool.query(
      `select id, target_type, target_id, target_slug, target_label, connection_type,
              link_text, link_context, occurrence_count
       from connections
       where source_type = 'page' and source_id = $1`,
      [pageId],
    );
    for (const conn of originalConnections.rows as {
      id: string;
      target_type: string;
      target_id: string | null;
      target_slug: string;
      target_label: string;
      connection_type: string;
      link_text: string | null;
      link_context: string | null;
      occurrence_count: number;
    }[]) {
      const insertResult = await pool.query(
        `insert into connections (
           source_type, source_id, target_type, target_id, target_slug,
           target_label, connection_type, link_text, link_context, occurrence_count, updated_at
         ) values ('page', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         returning id`,
        [
          newPageId,
          conn.target_type,
          conn.target_id,
          conn.target_slug,
          conn.target_label,
          conn.connection_type,
          conn.link_text,
          conn.link_context,
          conn.occurrence_count,
        ],
      );
      const newConnectionId = insertResult.rows[0]?.id;
      if (newConnectionId && conn.link_context) {
        await pool.query(
          `insert into connection_occurrences (connection_id, context)
           values ($1, $2)`,
          [newConnectionId, conn.link_context],
        );
      }
    }
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.delete(':id/permanent', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensureCanManageEntity('page', page.id, user.id);

  const userPages = await pool.query('select id, parent_id from pages where created_by = $1', [
    user.id,
  ]);

  const childMap = new Map<string, string[]>();
  for (const item of userPages.rows as { id: string; parent_id: string | null }[]) {
    if (!item.parent_id) {
      continue;
    }
    const list = childMap.get(item.parent_id) ?? [];
    list.push(item.id);
    childMap.set(item.parent_id, list);
  }

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
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  await pool.query('delete from pages where id = any($1)', [Array.from(toDelete)]);

  return c.json({ deleted: true });
});

export { pagesPublicRoute };
export default pagesRoute;
