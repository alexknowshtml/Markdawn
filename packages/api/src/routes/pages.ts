import { deriveCapabilities, MAX_PAGE_TITLE_LENGTH } from '@markdawn/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import JSZip from 'jszip';
import { marked } from 'marked';
import { auth } from '../auth';
import type { pages } from '../db';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import { ensureDocumentInputSize, ensureYdocSize, prepareCopiedYdoc } from '../utils/documentSize';
import { extractImages, pageToMarkdown } from '../utils/export-helpers';
import { slugifyFilename } from '../utils/filename';
import {
  createEmptyYjsDoc,
  createYjsDocWithTitle,
  resolveWikilinkTargets,
} from '../utils/markdown-to-yjs';
import { getNextPosition, normalizePosition } from '../utils/position';
import {
  ensureCanAdminEntity,
  ensureFolderAccess,
  ensurePageAccess,
  ensureWorkspaceAdmin,
  lockEntityAccessMutation,
  lockEntityAccessMutations,
  type SharePermission,
} from '../utils/share-access';
import { notifyShareRecompute, notifyShareRevoke } from '../utils/share-notify';
import { getUniqueWorkspacePageLookup } from '../utils/wiki-link-lookup';

type PageRow = typeof pages.$inferSelect;
type NormalizedPageRow = PageRow & { ownerId?: string | null };

function normalizePageTitle(title: string): string {
  if (title.length > MAX_PAGE_TITLE_LENGTH) {
    throw new HTTPException(400, {
      message: `Title must be ${MAX_PAGE_TITLE_LENGTH} characters or fewer`,
    });
  }
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

type RawPageRow = PageRow & {
  parent_id?: string | null;
  ownerId?: string | null;
  owner_id?: string | null;
  created_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  is_deleted?: boolean | null;
  deleted_at?: Date | null;
  is_public?: boolean | null;
  public_token?: string | null;
  inheritance_policy?: 'inherit' | 'restricted' | null;
};

type LinkPermission = 'view' | 'edit';
type PageLinkAccess = {
  permission: LinkPermission;
  token: string;
  source: 'page' | 'folder';
  sourceId: string;
};

const pagesRoute = new Hono();
const pagesPublicRoute = new Hono();

const deletedPageOwnerSql = `coalesce(
  (
    select root.created_by
    from folder_closure fc
    join folders root on root.id = fc.ancestor_id
    where fc.descendant_id = p.parent_id
      and root.parent_id is null
    order by fc.depth desc
    limit 1
  ),
  (
    select folder_owner.created_by
    from folders folder_owner
    where folder_owner.id = p.parent_id
  ),
  p.created_by
)`;

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

const getPageById = async (pageId: string, executor?: QueryExecutor) => {
  const statement =
    'select p.*, coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id from pages p where p.id = $1 and p.is_deleted = false limit 1';
  const result = executor
    ? await executeQuery(executor, statement, [pageId])
    : await query(statement, [pageId]);
  const row = (result.rows[0] as RawPageRow | undefined) ?? null;
  return row ? normalizePageRow(row) : null;
};

const ensurePageOrganizationAccess = async (
  page: NormalizedPageRow,
  targetParentId: string | null,
  userId: string,
  executor?: QueryExecutor,
) => {
  if (!page.ownerId) {
    throw new HTTPException(409, { message: 'Page owner could not be determined' });
  }
  if (targetParentId === page.id) {
    throw new HTTPException(400, { message: 'Cannot set parent to self' });
  }

  await ensurePageAccess(page.id, userId, 'admin', executor);
  if (page.parentId) {
    await ensureFolderAccess(page.parentId, userId, 'admin', executor);
  } else {
    await ensureWorkspaceAdmin(page.ownerId, userId, executor);
  }

  let destinationOwnerId: string | null = page.createdBy;
  if (targetParentId) {
    const ownerStatement = `select get_root_folder_owner(id) as owner_id
       from folders
       where id = $1 and is_deleted = false`;
    const ownerResult = executor
      ? await executeQuery<{ owner_id: string | null }>(executor, ownerStatement, [targetParentId])
      : await query<{ owner_id: string | null }>(ownerStatement, [targetParentId]);
    destinationOwnerId = ownerResult.rows[0]?.owner_id ?? null;
    if (!destinationOwnerId) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    await ensureFolderAccess(targetParentId, userId, 'admin', executor);
  } else if (destinationOwnerId) {
    await ensureWorkspaceAdmin(destinationOwnerId, userId, executor);
  }

  if (destinationOwnerId !== page.ownerId) {
    throw new HTTPException(409, { message: 'Pages cannot be moved between different owners' });
  }
};

const getDeletedPageById = async (pageId: string) => {
  const result = await query(
    `select p.*, ${deletedPageOwnerSql} as owner_id from pages p where p.id = $1 and p.is_deleted = true limit 1`,
    [pageId],
  );
  const row = (result.rows[0] as RawPageRow | undefined) ?? null;
  return row ? normalizePageRow(row) : null;
};

const normalizePageRow = (row: RawPageRow): NormalizedPageRow => ({
  ...row,
  parentId: row.parentId ?? row.parent_id ?? null,
  ownerId: row.ownerId ?? row.owner_id ?? null,
  createdBy: row.createdBy ?? row.created_by ?? null,
  createdAt: row.createdAt ?? row.created_at ?? null,
  updatedAt: row.updatedAt ?? row.updated_at ?? null,
  isDeleted: row.isDeleted ?? row.is_deleted ?? false,
  deletedAt: row.deletedAt ?? row.deleted_at ?? null,
  isPublic: row.isPublic ?? row.is_public ?? false,
  publicToken: row.publicToken ?? row.public_token ?? null,
  inheritancePolicy: row.inheritancePolicy ?? row.inheritance_policy ?? 'inherit',
});

const normalizeLinkPermission = (permission: string | null | undefined): LinkPermission => {
  return permission === 'edit' || permission === 'admin' ? 'edit' : 'view';
};

const getPageLinkAccess = async (
  pageId: string,
  executor?: QueryExecutor,
): Promise<PageLinkAccess | null> => {
  const statement = `
      with link_access as (
        select
          coalesce(s.permission, 'view') as permission,
          coalesce(s.token, p.public_token, p.id::text) as token,
          'page' as source,
          p.id as source_id,
          case coalesce(s.permission, 'view')
            when 'admin' then 3
            when 'edit' then 2
            else 1
          end as rank,
          0 as priority,
          0 as depth
        from pages p
        join lateral (
          select permission, token
          from shares
          where entity_type = 'page'
            and entity_id = p.id
            and token is not null
            and (expires_at is null or expires_at > now())
          order by updated_at desc nulls last
          limit 1
        ) s on true
        where p.id = $1
          and p.is_deleted = false
          and p.is_public = true

        union all

        select
          coalesce(s.permission, 'view') as permission,
          coalesce(s.token, f.public_token, f.id::text) as token,
          'folder' as source,
          f.id as source_id,
          case coalesce(s.permission, 'view')
            when 'admin' then 3
            when 'edit' then 2
            else 1
          end as rank,
          1 as priority,
          fc.depth
        from pages p
        join folder_closure fc on fc.descendant_id = p.parent_id
        join folders f on f.id = fc.ancestor_id and f.is_deleted = false
        join lateral (
          select permission, token
          from shares
          where entity_type = 'folder'
            and entity_id = f.id
            and token is not null
            and (expires_at is null or expires_at > now())
          order by updated_at desc nulls last
          limit 1
        ) s on true
        where p.id = $1
          and p.is_deleted = false
          and f.is_public = true
          and not is_page_folder_inheritance_blocked(f.id, p.id)
      )
      select permission, token, source, source_id
      from link_access
      order by rank desc, priority asc, depth asc
      limit 1
    `;
  const result = executor
    ? await executeQuery(executor, statement, [pageId])
    : await query(statement, [pageId]);

  const row = result.rows[0] as
    | {
        permission?: string | null;
        token?: string | null;
        source?: string | null;
        source_id?: string | null;
      }
    | undefined;
  if (!row?.token || !row.source_id || (row.source !== 'page' && row.source !== 'folder')) {
    return null;
  }

  return {
    permission: normalizeLinkPermission(row.permission),
    token: row.token,
    source: row.source,
    sourceId: row.source_id,
  };
};

const hasNonLinkPageAccess = async (pageId: string, userId: string): Promise<boolean> => {
  const result = await query(
    `with page_info as (
       select coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
              p.parent_id
       from pages p
       where p.id = $1 and p.is_deleted = false
     )
     select exists (
       select 1 from page_info where owner_id = $2
       union all
       select 1
       from shares s
       where s.entity_type = 'page'
         and s.entity_id = $1
         and s.recipient_user_id = $2
         and s.token is null
         and (s.expires_at is null or s.expires_at > now())
       union all
       select 1
       from page_info pi
       join shares s on s.entity_type = 'folder'
       join folders source_folder on source_folder.id = s.entity_id
       where s.entity_id in (select ancestor_id from folder_closure where descendant_id = pi.parent_id)
         and s.recipient_user_id = $2
         and s.token is null
         and source_folder.is_deleted = false
         and (s.expires_at is null or s.expires_at > now())
         and not is_page_folder_inheritance_blocked(s.entity_id, $1)
       union all
       select 1
       from page_info pi
       join workspace_members wm on wm.workspace_owner_id = pi.owner_id
       where wm.member_id = $2
         and not is_page_path_restricted($1)
     ) as has_access`,
    [pageId, userId],
  );
  return result.rows[0]?.has_access === true;
};

pagesRoute.get('/tree', async (c) => {
  // Return pages the user can access (owned or shared)
  const user = c.get('user') as { id: string };

  const result = await query(
    `
      select p.*,
             coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
             access.permission as user_permission,
             exists (
               select 1 from workspace_members wm
               where wm.workspace_owner_id = coalesce(get_root_folder_owner(p.parent_id), p.created_by)
                 and wm.member_id = $1
                 and not is_page_path_restricted(p.id)
             ) as workspace_access
      from pages p
      join lateral get_effective_page_permission(p.id, $1) access on true
      where p.is_deleted = false
        and p.id in (select page_id from get_accessible_page_ids($1))
      order by p.parent_id nulls first, case when p.parent_id is null then p.updated_at end desc nulls last, p.position::numeric asc
    `,
    [user.id],
  );

  const pagesList = (
    result.rows as (RawPageRow & {
      user_permission?: SharePermission | null;
      workspace_access?: boolean;
    })[]
  ).map((row) => ({
    ...normalizePageRow(row),
    userPermission: row.user_permission ?? null,
    workspaceAccess: row.workspace_access === true,
  }));
  return c.json(
    pagesList.map((page) => ({
      ...page,
      ydoc: undefined,
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

  const pageTitle =
    typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Untitled';
  const ydocBuffer = Buffer.from(createEmptyYjsDoc(pageTitle));

  const insertResult = await db.transaction(async (tx) => {
    if (parentId) {
      await lockEntityAccessMutation(tx, 'folder', parentId);
      await ensureFolderAccess(parentId, user.id, 'admin', tx);
    }

    const nextPosition = await getNextPosition('pages', parentId ?? null, user.id, tx);
    return executeQuery(
      tx,
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
  });

  if (insertResult.rowCount === 0) {
    throw new HTTPException(500, { message: 'Failed to create page' });
  }

  const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.get('/trash', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `select p.*, ${deletedPageOwnerSql} as owner_id
     from pages p
     where p.is_deleted = true
       and ${deletedPageOwnerSql} = $1
     order by p.deleted_at desc nulls last, p.position::numeric asc`,
    [user.id],
  );

  return c.json((result.rows as RawPageRow[]).map(normalizePageRow));
});

pagesRoute.delete('/trash/empty-all', async (c) => {
  const user = c.get('user') as { id: string };

  const userPages = await query(
    `select p.id, p.parent_id, p.is_deleted
     from pages p
     where ${deletedPageOwnerSql} = $1`,
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
    await query('delete from pages where id = any($1)', [Array.from(toDelete)]);
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

  const result = await query(
    `select
       p.id,
       p.title,
       p.icon,
       p.created_by as "createdBy",
       coalesce(get_root_folder_owner(p.parent_id), p.created_by) as "ownerId",
       p.updated_at as "updatedAt",
       pv.visited_at as "visitedAt"
     from page_visits pv
     join pages p on p.id = pv.page_id
     join lateral get_effective_page_permission(p.id, $1) access on true
     where pv.user_id = $1
       and p.is_deleted = false
       and access.permission is not null
     order by pv.visited_at desc
     limit $2`,
    [user.id, parsedLimit],
  );

  return c.json(
    result.rows as {
      id: string;
      title: string;
      icon: string | null;
      createdBy: string | null;
      ownerId: string | null;
      updatedAt: Date;
      visitedAt: Date;
    }[],
  );
});

pagesPublicRoute.patch(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}/title',
  bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => c.json({ message: 'Request body is too large' }, 413),
  }),
  async (c) => {
    const pageId = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Malformed JSON is an expected HTTP boundary failure.
        throw new HTTPException(400, { message: 'Invalid JSON body' });
      }
      throw error;
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { title?: unknown }).title !== 'string'
    ) {
      throw new HTTPException(400, { message: 'Title is required' });
    }
    const nextTitle = normalizePageTitle((body as { title: string }).title);

    const result = await db.transaction(async (tx) => {
      await lockEntityAccessMutation(tx, 'page', pageId);
      const page = await getPageById(pageId, tx);
      if (!page) {
        throw new HTTPException(404, { message: 'Page not found' });
      }
      const linkAccess = await getPageLinkAccess(pageId, tx);
      if (!linkAccess) {
        throw new HTTPException(404, { message: 'Page not found' });
      }
      if (linkAccess.permission !== 'edit') {
        throw new HTTPException(403, { message: 'Forbidden' });
      }

      if (page.title !== nextTitle) {
        await executeQuery(
          tx,
          "update pages set title = $1, title_search = to_tsvector('english', $1), updated_at = now() where id = $2",
          [nextTitle, pageId],
        );
        await executeQuery(tx, 'select pg_notify($1, $2)', [
          'page_renamed',
          JSON.stringify({ pageId }),
        ]);
      }
      return { title: nextTitle };
    });

    return c.json(result);
  },
);

pagesPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    const pageId = c.req.param('id');
    const page = await getPageById(pageId);

    if (!page) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const linkAccess = await getPageLinkAccess(pageId);
    let userPermission: 'view' | 'edit' | 'admin' | null = null;
    let userCapabilities = deriveCapabilities(null);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const user = session.user as { id: string };
      try {
        const access = await ensurePageAccess(page.id, user.id);
        userPermission = access.permission;
        userCapabilities = deriveCapabilities(access.permission, access.fullAccess);
      } catch (error) {
        if (!(error instanceof HTTPException) || error.status !== 403 || !linkAccess) {
          throw error;
        }
        userPermission = linkAccess.permission;
        userCapabilities = deriveCapabilities(linkAccess.permission);
      }
      await query(
        'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
        [user.id, pageId],
      );
    } else {
      if (!linkAccess) {
        throw new HTTPException(404, { message: 'Page not found' });
      }
      userPermission = linkAccess.permission;
      userCapabilities = deriveCapabilities(linkAccess.permission);
    }

    return c.json({
      ...page,
      isPublic: page.isPublic || !!linkAccess,
      ydoc: undefined,
      linkPermission: linkAccess?.permission ?? null,
      userPermission,
      capabilities: userCapabilities,
    });
  },
);

pagesRoute.post(':id/access', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  const linkAccess = await getPageLinkAccess(pageId);
  const hasAccountAccess = await hasNonLinkPageAccess(page.id, user.id);

  if (!hasAccountAccess && !linkAccess) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  let recordedLinkAccess = false;
  let linkAccessSource: 'page' | 'folder' | null = null;

  if (!hasAccountAccess) {
    if (!linkAccess) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    recordedLinkAccess = true;
    linkAccessSource = linkAccess.source;

    if (linkAccess.source === 'page') {
      await query(
        `
          insert into page_access_events (page_id, user_id, source, token, permission, first_seen_at, last_seen_at)
          values ($1, $2, 'link', $3, $4, now(), now())
          on conflict (page_id, user_id, source, token)
          do update set permission = excluded.permission, last_seen_at = now()
        `,
        [page.id, user.id, linkAccess.token, linkAccess.permission],
      );
    } else {
      await query(
        `
          insert into folder_access_events (folder_id, user_id, source, token, permission, first_seen_at, last_seen_at)
          values ($1, $2, 'link', $3, $4, now(), now())
          on conflict (folder_id, user_id, source, token)
          do update set permission = excluded.permission, last_seen_at = now()
        `,
        [linkAccess.sourceId, user.id, linkAccess.token, linkAccess.permission],
      );
    }
  }

  await query(
    'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
    [user.id, pageId],
  );

  return c.json({ ok: true, recordedLinkAccess, linkAccessSource });
});

pagesRoute.patch(':id/restore', async (c) => {
  const pageId = c.req.param('id');
  const page = await getDeletedPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  if (page.ownerId !== user.id) {
    throw new HTTPException(403, { message: 'You can only restore pages that you own' });
  }

  const updateResult = await db.transaction(async (tx) => {
    const lockedPageResult = await executeQuery<{
      parent_id: string | null;
      created_by: string | null;
    }>(
      tx,
      `select parent_id, created_by
       from pages
       where id = $1 and is_deleted = true
       for update`,
      [pageId],
    );
    const lockedPage = lockedPageResult.rows[0];
    if (!lockedPage) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    let restoreParentId: string | null = null;
    if (lockedPage.parent_id) {
      const parentResult = await executeQuery<{ id: string }>(
        tx,
        `select id
         from folders
         where id = $1 and is_deleted = false
         for share`,
        [lockedPage.parent_id],
      );
      if (parentResult.rowCount && parentResult.rowCount > 0) {
        restoreParentId = lockedPage.parent_id;
      }
    }

    const restoreCreatorId = restoreParentId ? lockedPage.created_by : user.id;
    const nextPosition = await getNextPosition('pages', restoreParentId, user.id, tx);
    return executeQuery(
      tx,
      `update pages
       set is_deleted = false,
           deleted_at = null,
           parent_id = $1,
           created_by = $2,
           position = $3,
           title_search = to_tsvector('english', title),
           updated_at = now()
       where id = $4 and is_deleted = true
       returning *`,
      [restoreParentId, restoreCreatorId, nextPosition, pageId],
    );
  });

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

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Malformed JSON is an expected HTTP boundary failure.
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }
    throw error;
  }
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
  const hasPosition = Object.hasOwn(body, 'position');
  const hasCoverType = Object.hasOwn(body, 'coverType');
  const hasCoverValue = Object.hasOwn(body, 'coverValue');
  const hasProperties = Object.hasOwn(body, 'properties');
  const normalizedRequestedTitle =
    typeof title === 'string' ? normalizePageTitle(title) : undefined;

  const updateResult = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const nextParent = hasParentId ? (parentId ?? null) : currentPage.parentId;
    if (hasParentId || hasPosition) {
      await ensurePageOrganizationAccess(currentPage, nextParent, user.id, tx);
    } else {
      await ensurePageAccess(currentPage.id, user.id, 'edit', tx);
    }

    const nextTitle = normalizedRequestedTitle ?? currentPage.title;
    const nextIcon =
      typeof icon === 'string'
        ? icon.trim().length > 0
          ? icon.trim()
          : null
        : icon === null
          ? null
          : currentPage.icon;
    const nextPosition = normalizePosition(position, currentPage.position);
    const nextCoverType = hasCoverType
      ? typeof coverType === 'string' && coverType.trim().length > 0
        ? coverType.trim()
        : null
      : currentPage.coverType;
    const nextCoverValue = hasCoverValue
      ? typeof coverValue === 'string' && coverValue.trim().length > 0
        ? coverValue.trim()
        : null
      : currentPage.coverValue;
    const nextProperties = hasProperties
      ? properties && typeof properties === 'object'
        ? JSON.stringify(properties)
        : null
      : currentPage.properties;

    const result = hasProperties
      ? await executeQuery(
          tx,
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
      : await executeQuery(
          tx,
          "update pages set title = $1, title_search = to_tsvector('english', $1), icon = $2, parent_id = $3, position = $4, cover_type = $5, cover_value = $6, updated_at = now() where id = $7 returning *",
          [nextTitle, nextIcon, nextParent, nextPosition, nextCoverType, nextCoverValue, pageId],
        );

    if (result.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to update page' });
    }

    // Keep the payload bounded; the collaboration server reloads the title
    // from PostgreSQL after this transaction commits.
    if (currentPage.title !== nextTitle) {
      await executeQuery(tx, 'select pg_notify($1, $2)', [
        'page_renamed',
        JSON.stringify({ pageId }),
      ]);
    }
    if (hasParentId && nextParent !== currentPage.parentId) {
      await notifyShareRecompute({ entityType: 'page', entityId: pageId }, tx);
    }
    return result;
  });

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

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const { parentId, position } = body as {
    parentId?: string | null;
    position?: string | number;
  };

  const hasParentId = Object.hasOwn(body, 'parentId');

  const updateResult = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const nextParent = hasParentId ? (parentId ?? null) : currentPage.parentId;
    await ensurePageOrganizationAccess(currentPage, nextParent, user.id, tx);
    const nextPosition = normalizePosition(position, currentPage.position);
    const result = await executeQuery(
      tx,
      'update pages set parent_id = $1, position = $2, updated_at = now() where id = $3 returning *',
      [nextParent, nextPosition, pageId],
    );

    if (result.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to move page' });
    }

    if (hasParentId && nextParent !== currentPage.parentId) {
      await notifyShareRecompute({ entityType: 'page', entityId: pageId }, tx);
    }
    return result;
  });

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
  await ensurePageAccess(page.id, user.id);

  const uploadResult = await query<{ filename: string }>(
    `select u.filename
     from uploads u
     join upload_page_refs upr on upr.upload_id = u.id
     where upr.page_id = $1`,
    [pageId],
  );
  const authorizedUploadFilenames = new Set(uploadResult.rows.map((row) => row.filename));
  const baseFilename = slugifyFilename(page.title || 'Untitled') || 'untitled';
  const markdown = pageToMarkdown(page.ydoc, page.properties, page.icon, page.title || undefined);
  const extracted = await extractImages(markdown, uploadsDir, authorizedUploadFilenames);

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
  await ensurePageAccess(page.id, user.id, 'edit');

  const contentType = c.req.header('content-type') ?? '';
  let markdown = '';

  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Invalid body' });
    }
    const bodyMarkdown = (body as { markdown?: string }).markdown;
    markdown = typeof bodyMarkdown === 'string' ? bodyMarkdown : '';
    ensureDocumentInputSize(markdown);
  } else if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: 'File is required' });
    }
    ensureDocumentInputSize(file);
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

  // Resolve only unique titles in the destination workspace so imports never
  // bind to another owner's similarly named private page.
  if (!page.ownerId) {
    throw new HTTPException(409, { message: 'Page owner could not be determined' });
  }
  const pageLookup = await getUniqueWorkspacePageLookup(page.ownerId);

  const updateResult = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) throw new HTTPException(404, { message: 'Page not found' });
    await ensurePageAccess(pageId, user.id, 'edit', tx);

    // Build the final Yjs state only after authorization is serialized so a
    // concurrent title change cannot be replaced by stale imported state.
    let ydocBuffer = Buffer.from(createYjsDocWithTitle(currentPage.title || 'Untitled', markdown));
    if (pageLookup.size > 0) {
      ydocBuffer = Buffer.from(resolveWikilinkTargets(ydocBuffer, pageLookup));
    }
    ensureYdocSize(ydocBuffer);

    return executeQuery(
      tx,
      "update pages set ydoc = $1, title = $2, title_search = to_tsvector('english', $2), updated_at = now() where id = $3",
      [ydocBuffer, currentPage.title || 'Untitled', pageId],
    );
  });

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
  await ensureCanAdminEntity('page', page.id, user.id);

  await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    await ensureCanAdminEntity('page', pageId, user.id, tx);
    const updateResult = await executeQuery(
      tx,
      'update pages set is_deleted = true, deleted_at = now(), updated_at = now() where id = $1',
      [pageId],
    );

    if (updateResult.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to delete page' });
    }

    // Notify the collab server so it removes the page from the meta room.
    await executeQuery(tx, 'select pg_notify($1, $2)', [
      'page_deleted',
      JSON.stringify({ pageId }),
    ]);
  });

  return c.json({ deleted: true });
});

pagesRoute.post(':id/leave', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };

  const ownerResult = await query(
    'SELECT COALESCE(get_root_folder_owner($1), (SELECT created_by FROM pages WHERE id = $2)) as owner_id',
    [page.parentId, pageId],
  );
  const ownerId = ownerResult.rows[0]?.owner_id as string | undefined;
  if (ownerId === user.id) {
    throw new HTTPException(400, { message: 'Cannot leave your own page' });
  }

  await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    const shareResult = await executeQuery(
      tx,
      "delete from shares where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2 returning id, recipient_user_id",
      [pageId, user.id],
    );
    const eventResult = await executeQuery(
      tx,
      'delete from page_access_events where page_id = $1 and user_id = $2 returning id',
      [pageId, user.id],
    );

    const shareRow = shareResult.rows[0] as { id: string; recipient_user_id: string } | undefined;
    if (!shareRow && (eventResult.rowCount ?? 0) === 0) {
      throw new HTTPException(409, {
        message: 'This page is inherited from a folder or workspace and cannot be left directly',
      });
    }

    if (shareRow?.recipient_user_id) {
      await notifyShareRevoke(
        {
          entityType: 'page',
          entityId: pageId,
          targetUserId: shareRow.recipient_user_id,
        },
        tx,
      );
    }
  });

  return c.json({ ok: true });
});

pagesRoute.post(':id/copy', async (c) => {
  const pageId = c.req.param('id');
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(page.id, user.id);

  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;

  if (parentId) {
    const folderResult = await query(
      'select id from folders where id = $1 and is_deleted = false limit 1',
      [parentId],
    );
    if (folderResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Parent folder not found' });
    }
    await ensureFolderAccess(parentId, user.id, 'admin');
  }

  const copiedPage = await db.transaction(async (tx) => {
    await lockEntityAccessMutations(tx, [
      { entityType: 'page', entityId: pageId },
      ...(parentId ? [{ entityType: 'folder' as const, entityId: parentId }] : []),
    ]);
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) throw new HTTPException(404, { message: 'Page not found' });
    await ensurePageAccess(pageId, user.id, 'view', tx);
    if (parentId) await ensureFolderAccess(parentId, user.id, 'admin', tx);

    const copiedYdoc = prepareCopiedYdoc(currentPage.ydoc, `Copy of ${currentPage.title}`);
    const nextPosition = await getNextPosition('pages', parentId ?? null, user.id, tx);
    const insertResult = await executeQuery(
      tx,
      `insert into pages (id, parent_id, title, title_search, icon, cover_type, cover_value, position, ydoc, properties, created_by)
       select gen_random_uuid(), $1, $2, to_tsvector('english', $2), icon, cover_type, cover_value, $3, $4, properties, $5
       from pages where id = $6 and is_deleted = false
       returning id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by, created_at, updated_at, is_deleted`,
      [parentId ?? null, `Copy of ${currentPage.title}`, nextPosition, copiedYdoc, user.id, pageId],
    );
    const insertedPage = insertResult.rows[0] as RawPageRow | undefined;
    if (!insertedPage) {
      throw new HTTPException(500, { message: 'Failed to copy page' });
    }

    await executeQuery(
      tx,
      `insert into upload_page_refs (upload_id, page_id)
       select upload_id, $1 from upload_page_refs where page_id = $2
       on conflict (upload_id, page_id) do nothing`,
      [insertedPage.id, pageId],
    );
    await executeQuery(
      tx,
      `insert into connections (
         source_type, source_id, target_type, target_id, target_slug,
         target_label, connection_type, link_text, link_context,
         occurrence_count, first_seen_at, updated_at
       )
       select source_type, $1, target_type, target_id, target_slug,
              target_label, connection_type, link_text, link_context,
              occurrence_count, first_seen_at, now()
       from connections
       where source_type = 'page' and source_id = $2`,
      [insertedPage.id, pageId],
    );
    await executeQuery(
      tx,
      `insert into connection_occurrences (
         connection_id, source_block_id, position, context, created_at
       )
       select copied.id, occurrence.source_block_id, occurrence.position,
              occurrence.context, occurrence.created_at
       from connections original
       join connections copied
         on copied.source_type = original.source_type
        and copied.source_id = $1
        and copied.target_type = original.target_type
        and copied.target_slug = original.target_slug
        and copied.connection_type = original.connection_type
       join connection_occurrences occurrence on occurrence.connection_id = original.id
       where original.source_type = 'page' and original.source_id = $2`,
      [insertedPage.id, pageId],
    );
    return insertedPage;
  });

  const created = normalizePageRow(copiedPage);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.delete(':id/permanent', async (c) => {
  const pageId = c.req.param('id');
  const deletedPage = await getDeletedPageById(pageId);
  const page = deletedPage ?? (await getPageById(pageId));

  if (!page) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  if (deletedPage) {
    if (page.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: 'You can only permanently delete pages that you own',
      });
    }
  } else {
    await ensureCanAdminEntity('page', page.id, user.id);
  }

  const userPages = await query(
    `select p.id, p.parent_id
     from pages p
     where ${deletedPageOwnerSql} = $1`,
    [user.id],
  );

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

  await db.transaction(async (tx) => {
    if (!deletedPage) {
      await lockEntityAccessMutation(tx, 'page', pageId);
      await ensureCanAdminEntity('page', pageId, user.id, tx);
    }
    await executeQuery(tx, 'delete from pages where id = any($1)', [Array.from(toDelete)]);
  });

  return c.json({ deleted: true });
});

export { pagesPublicRoute };
export default pagesRoute;
