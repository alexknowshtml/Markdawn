import { deriveCapabilities } from '@markdawn/shared';
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
import { purgeEntityAccessMetadata } from '../utils/entityCleanup';
import { extractImages, pageToMarkdown } from '../utils/export-helpers';
import { slugifyFilename } from '../utils/filename';
import { getEnumerableFolderIds, redactParentId } from '../utils/folderEnumeration';
import {
  createEmptyYjsDoc,
  createYjsDocWithTitle,
  normalizeWikilinkLookupKey,
} from '../utils/markdown-to-yjs';
import { createCopyPageTitle, normalizePageTitle } from '../utils/pageTitle';
import { getNextPosition, normalizePosition } from '../utils/position';
import {
  ensureCanAdminEntity,
  ensureFolderAccess,
  ensurePageAccess,
  ensureWorkspaceAdmin,
  lockEntityAccess,
  lockEntityAccessMutation,
  lockEntityAccessMutations,
  lockWorkspaceAccessMutation,
  type SharePermission,
} from '../utils/share-access';
import { notifyShareRecompute, notifyShareRevoke } from '../utils/share-notify';
import { getEntityMetaUserIds, mergeMetaUserIds } from '../utils/shareRecipients';
import {
  processUploadDeletionQueue,
  purgeUnreferencedUploadsForPages,
} from '../utils/uploadCleanup';

type PageRow = typeof pages.$inferSelect;
type NormalizedPageRow = PageRow & { ownerId?: string | null };

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
  cover_type?: string | null;
  cover_value?: string | null;
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

const getPresentedShareToken = (c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): string | null => {
  const token = c.req.header('x-share-token') ?? c.req.query('share') ?? null;
  const trimmed = token?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

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

const getPageByIdForUpdate = async (
  pageId: string,
  executor: QueryExecutor,
): Promise<NormalizedPageRow | null> => {
  const result = await executeQuery(
    executor,
    `select p.*, coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id
     from pages p
     where p.id = $1 and p.is_deleted = false
     limit 1
     for update of p`,
    [pageId],
  );
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
  coverType: row.coverType ?? row.cover_type ?? null,
  coverValue: row.coverValue ?? row.cover_value ?? null,
});

const toPageDto = (page: NormalizedPageRow, parentId: string | null) => ({
  id: page.id,
  parentId,
  title: page.title,
  icon: page.icon,
  coverType: page.coverType,
  coverValue: page.coverValue,
  position: page.position,
  properties: page.properties,
  createdBy: page.createdBy,
  ownerId: page.ownerId ?? null,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
  isPublic: page.isPublic,
  inheritancePolicy: page.inheritancePolicy,
});

const toPublicPageDto = (
  page: NormalizedPageRow,
  linkAccess: PageLinkAccess,
  userPermission: LinkPermission,
) => ({
  id: page.id,
  title: page.title,
  icon: page.icon,
  coverType: page.coverType,
  coverValue: page.coverValue,
  properties: page.properties,
  updatedAt: page.updatedAt,
  isPublic: true,
  linkPermission: linkAccess.permission,
  userPermission,
  capabilities: deriveCapabilities(userPermission),
});

const toAuthenticatedPageDto = (
  page: NormalizedPageRow,
  parentId: string | null,
  linkAccess: PageLinkAccess | null,
  userPermission: SharePermission,
  capabilities: ReturnType<typeof deriveCapabilities>,
) => ({
  ...toPageDto(page, parentId),
  isPublic: page.isPublic || !!linkAccess,
  linkPermission: linkAccess?.permission ?? null,
  userPermission,
  capabilities,
});

const normalizeLinkPermission = (permission: string | null | undefined): LinkPermission => {
  return permission === 'edit' || permission === 'admin' ? 'edit' : 'view';
};

const getPageLinkAccesses = async (
  pageId: string,
  executor?: QueryExecutor,
): Promise<PageLinkAccess[]> => {
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
            and (expires_at is null or expires_at > statement_timestamp())
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
            and (expires_at is null or expires_at > statement_timestamp())
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
    `;
  const result = executor
    ? await executeQuery(executor, statement, [pageId])
    : await query(statement, [pageId]);

  return result.rows.flatMap((value) => {
    const row = value as {
      permission?: string | null;
      token?: string | null;
      source?: string | null;
      source_id?: string | null;
    };
    if (!row.token || !row.source_id || (row.source !== 'page' && row.source !== 'folder')) {
      return [];
    }
    return [
      {
        permission: normalizeLinkPermission(row.permission),
        token: row.token,
        source: row.source,
        sourceId: row.source_id,
      } satisfies PageLinkAccess,
    ];
  });
};

const findPageLinkAccessByToken = (accesses: readonly PageLinkAccess[], token: string | null) => {
  if (!token) return null;
  return accesses.find((access) => access.token === token) ?? null;
};

const recordPageLinkAccesses = async (
  executor: QueryExecutor,
  pageId: string,
  userId: string,
  linkAccesses: readonly PageLinkAccess[],
): Promise<boolean> => {
  let insertedAny = false;
  for (const linkAccess of linkAccesses) {
    if (linkAccess.source !== 'page') continue;

    const insertResult = await executeQuery(
      executor,
      `insert into page_access_events
         (page_id, user_id, source, token, permission, first_seen_at, last_seen_at)
       values ($1, $2, 'link', $3, $4, now(), now())
       on conflict (page_id, user_id, source, token)
       do nothing
       returning id`,
      [pageId, userId, linkAccess.token, linkAccess.permission],
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      await executeQuery(
        executor,
        `update page_access_events
         set permission = $1, last_seen_at = now()
         where page_id = $2 and user_id = $3 and source = 'link' and token = $4`,
        [linkAccess.permission, pageId, userId, linkAccess.token],
      );
    } else {
      insertedAny = true;
    }
  }
  return insertedAny;
};

const hasNonLinkPageAccess = async (
  pageId: string,
  userId: string,
  executor?: QueryExecutor,
): Promise<boolean> => {
  const statement = `with page_info as (
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
         and (s.expires_at is null or s.expires_at > statement_timestamp())
       union all
       select 1
       from page_info pi
       join shares s on s.entity_type = 'folder'
       join folders source_folder on source_folder.id = s.entity_id
       where s.entity_id in (select ancestor_id from folder_closure where descendant_id = pi.parent_id)
         and s.recipient_user_id = $2
         and s.token is null
         and source_folder.is_deleted = false
         and (s.expires_at is null or s.expires_at > statement_timestamp())
         and not is_page_folder_inheritance_blocked(s.entity_id, $1)
       union all
       select 1
       from page_info pi
       join workspace_members wm on wm.workspace_owner_id = pi.owner_id
       where wm.member_id = $2
         and not is_page_path_restricted($1)
     ) as has_access`;
  const result = executor
    ? await executeQuery(executor, statement, [pageId, userId])
    : await query(statement, [pageId, userId]);
  return result.rows[0]?.has_access === true;
};

pagesRoute.get('/tree', async (c) => {
  // Return pages the user can access (owned or shared)
  const user = c.get('user') as { id: string };

  const result = await query(
    `
      select p.*,
             coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
             case
               when p.parent_id in (select folder_id from get_enumerable_folder_ids($1))
                 then p.parent_id
               else null
             end as enumerable_parent_id,
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
      enumerable_parent_id?: string | null;
      user_permission?: SharePermission | null;
      workspace_access?: boolean;
    })[]
  ).map((row) => {
    const page = normalizePageRow(row);
    return {
      ...toPageDto(page, row.enumerable_parent_id ?? null),
      userPermission: row.user_permission ?? null,
      workspaceAccess: row.workspace_access === true,
    };
  });
  return c.json(
    pagesList.map((page) => ({
      ...page,
      children: [],
    })),
  );
});

pagesRoute.post(
  '/',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ message: 'Request body is too large' }, 413),
  }),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new HTTPException(400, { message: 'Invalid JSON body' });
      }
      throw error;
    }
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Invalid body' });
    }

    const { parentId, title, icon } = body as {
      parentId?: string | null;
      title?: string;
      icon?: string | null;
    };

    const user = c.get('user') as { id: string };

    const pageTitle = typeof title === 'string' ? normalizePageTitle(title) : 'Untitled';
    const ydocBuffer = Buffer.from(createEmptyYjsDoc(pageTitle));
    ensureYdocSize(ydocBuffer);

    const insertResult = await db.transaction(async (tx) => {
      if (parentId) {
        await lockEntityAccessMutation(tx, 'folder', parentId);
        await ensureFolderAccess(parentId, user.id, 'admin', tx);
      } else {
        await lockWorkspaceAccessMutation(tx, user.id);
      }

      const nextPosition = await getNextPosition('pages', parentId ?? null, user.id, tx);
      const result = await executeQuery(
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
      const createdPageId = result.rows[0]?.id as string | undefined;
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
      return result;
    });

    if (insertResult.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to create page' });
    }

    const created = normalizePageRow(insertResult.rows[0] as RawPageRow);
    return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
  },
);

pagesRoute.get('/trash', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `select p.*, ${deletedPageOwnerSql} as owner_id
     from pages p
     left join folders parent on parent.id = p.parent_id
     where p.is_deleted = true
       and ${deletedPageOwnerSql} = $1
       and coalesce(parent.is_deleted, false) = false
     order by p.deleted_at desc nulls last, p.position::numeric asc`,
    [user.id],
  );

  return c.json((result.rows as RawPageRow[]).map(normalizePageRow));
});

pagesRoute.delete('/trash/empty-all', async (c) => {
  const user = c.get('user') as { id: string };
  const count = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const trashedPages = await executeQuery<{ id: string }>(
      tx,
      `select p.id
       from pages p
       left join folders parent on parent.id = p.parent_id
       where p.is_deleted = true
         and ${deletedPageOwnerSql} = $1
         and coalesce(parent.is_deleted, false) = false
       order by p.id
       for update of p`,
      [user.id],
    );
    const pageIds = trashedPages.rows.map((row) => row.id);
    await purgeUnreferencedUploadsForPages(tx, pageIds);
    if (pageIds.length > 0) {
      await purgeEntityAccessMetadata(tx, 'page', pageIds);
      await executeQuery(tx, 'delete from pages where id = any($1::uuid[]) and is_deleted = true', [
        pageIds,
      ]);
    }
    return pageIds.length;
  });
  await processUploadDeletionQueue();

  return c.json({ deleted: true, count });
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
    const shareToken = getPresentedShareToken(c);
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
      await lockEntityAccess(tx, 'page', pageId);
      const page = await getPageById(pageId, tx);
      if (!page) {
        throw new HTTPException(404, { message: 'Page not found' });
      }
      const linkAccess = findPageLinkAccessByToken(
        await getPageLinkAccesses(pageId, tx),
        shareToken,
      );
      if (!linkAccess) {
        throw new HTTPException(404, { message: 'Page not found' });
      }
      if (linkAccess.permission !== 'edit') {
        throw new HTTPException(403, { message: 'Forbidden' });
      }

      if (page.title !== nextTitle) {
        await executeQuery(
          tx,
          `update pages
           set title_revision = title_revision + 1,
               title = $1,
               title_search = to_tsvector('english', $1),
               updated_at = now()
           where id = $2`,
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
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}/wiki-link-target',
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const pageId = c.req.param('id');
    const shareToken = getPresentedShareToken(c);
    const authoredPath = c.req.query('path') ?? '';
    const pathWithoutHeading = authoredPath.split('#')[0] ?? '';
    const targetSlug = normalizeWikilinkLookupKey(pathWithoutHeading);
    if (!targetSlug || targetSlug.length > 1_000) return c.json({ target: null });

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
    const result = await query<{
      source_authorized: boolean;
      target_id: string | null;
      target_title: string | null;
    }>(
      `with access_snapshot as materialized (
         select statement_timestamp() as as_of
       ), source_state as materialized (
         select source_page.id,
                coalesce(
                  get_root_folder_owner(source_page.parent_id),
                  source_page.created_by
                ) as owner_id,
                 (
                   (
                     $3::uuid is not null
                     and exists (
                       select 1
                       from access_snapshot snapshot
                       cross join lateral get_effective_page_permission_at(
                         source_page.id, $3::uuid, snapshot.as_of
                       ) access
                       where access.permission is not null
                     )
                   )
                   or (
                     $4::text is not null
                     and exists (
                       select 1
                       from shares page_link
                       where page_link.entity_type = 'page'
                         and page_link.entity_id = source_page.id
                         and page_link.token = $4
                         and page_link.token is not null
                         and (page_link.expires_at is null or page_link.expires_at > statement_timestamp())
                     )
                   )
                   or (
                     $4::text is not null
                     and exists (
                       select 1
                       from folder_closure fc
                       join folders source_folder
                         on source_folder.id = fc.ancestor_id
                        and source_folder.is_public = true
                        and source_folder.is_deleted = false
                       join shares folder_link
                         on folder_link.entity_type = 'folder'
                        and folder_link.entity_id = source_folder.id
                        and folder_link.token = $4
                        and folder_link.token is not null
                        and (folder_link.expires_at is null or folder_link.expires_at > statement_timestamp())
                       where fc.descendant_id = source_page.parent_id
                         and not is_page_folder_inheritance_blocked(source_folder.id, source_page.id)
                     )
                   )
                 ) as authorized
         from pages source_page
         where source_page.id = $1 and source_page.is_deleted = false
       ), mapped_candidate_ids as materialized (
         select distinct c.target_id
         from connections c
         join source_state source_page on source_page.id = c.source_id
         where c.source_type = 'page'
           and c.source_id = $1
           and c.target_type = 'page'
           and c.target_id is not null
           and c.target_slug = $2
           and c.connection_type in ('wikilink', 'heading')
       ), unique_candidate as (
         select min(target_id::text)::uuid as target_id
         from mapped_candidate_ids
         having count(*) = 1
       )
       select source.authorized as source_authorized,
              target.id as target_id,
              target.title as target_title
       from source_state source
       cross join access_snapshot snapshot
       left join unique_candidate candidate on true
       left join pages target
         on target.id = candidate.target_id
        and target.is_deleted = false
        and coalesce(get_root_folder_owner(target.parent_id), target.created_by) = source.owner_id
         and (
           (
             $3::uuid is not null
             and exists (
               select 1
               from get_effective_page_permission_at(target.id, $3::uuid, snapshot.as_of) access
               where access.permission is not null
             )
           )
           or (
             $4::text is not null
             and exists (
               select 1
               from shares page_link
               where page_link.entity_type = 'page'
                 and page_link.entity_id = target.id
                 and page_link.token = $4
                 and page_link.token is not null
                 and (page_link.expires_at is null or page_link.expires_at > statement_timestamp())
             )
           )
           or (
             $4::text is not null
             and exists (
               select 1
               from folder_closure fc
               join folders source_folder
                 on source_folder.id = fc.ancestor_id
                and source_folder.is_public = true
                and source_folder.is_deleted = false
               join shares folder_link
                 on folder_link.entity_type = 'folder'
                and folder_link.entity_id = source_folder.id
                and folder_link.token = $4
                and folder_link.token is not null
                and (folder_link.expires_at is null or folder_link.expires_at > statement_timestamp())
               where fc.descendant_id = target.parent_id
                 and not is_page_folder_inheritance_blocked(source_folder.id, target.id)
             )
           )
         )`,
      [pageId, targetSlug, sessionUserId, shareToken],
    );

    const resolution = result.rows[0];
    if (!resolution?.source_authorized) {
      throw new HTTPException(404, { message: 'Page not found' });
    }
    return c.json({
      target:
        resolution.target_id && resolution.target_title
          ? { id: resolution.target_id, title: resolution.target_title }
          : null,
    });
  },
);

pagesPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    const pageId = c.req.param('id');
    const shareToken = getPresentedShareToken(c);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
    const result = await db.transaction(async (tx) => {
      await lockEntityAccess(tx, 'page', pageId);
      const page = await getPageById(pageId, tx);
      if (!page) {
        throw new HTTPException(404, { message: 'Page not found' });
      }

      const linkAccesses = await getPageLinkAccesses(pageId, tx);
      const linkAccess = findPageLinkAccessByToken(linkAccesses, shareToken);
      const hasAccountAccess = sessionUserId
        ? await hasNonLinkPageAccess(pageId, sessionUserId, tx)
        : false;

      if (!hasAccountAccess && !linkAccess) {
        throw new HTTPException(404, { message: 'Page not found' });
      }

      let userPermission: SharePermission;
      let userCapabilities: ReturnType<typeof deriveCapabilities>;
      if (sessionUserId && hasAccountAccess) {
        const access = await ensurePageAccess(pageId, sessionUserId, 'view', tx);
        userPermission = access.permission;
        userCapabilities = deriveCapabilities(access.permission, access.fullAccess);
      } else if (linkAccess) {
        userPermission = linkAccess.permission;
        userCapabilities = deriveCapabilities(linkAccess.permission);
      } else {
        throw new HTTPException(404, { message: 'Page not found' });
      }

      if (sessionUserId) {
        await executeQuery(
          tx,
          'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
          [sessionUserId, pageId],
        );
      }

      const enumerableFolderIds =
        sessionUserId && hasAccountAccess
          ? await getEnumerableFolderIds(sessionUserId, tx)
          : new Set<string>();
      return {
        page,
        parentId: redactParentId(page.parentId, enumerableFolderIds),
        linkAccess,
        hasAccountAccess,
        userPermission,
        userCapabilities,
      };
    });

    if (!result.hasAccountAccess) {
      if (!result.linkAccess) throw new HTTPException(404, { message: 'Page not found' });
      return c.json(toPublicPageDto(result.page, result.linkAccess, result.linkAccess.permission));
    }

    return c.json(
      toAuthenticatedPageDto(
        result.page,
        result.parentId,
        result.linkAccess,
        result.userPermission,
        result.userCapabilities,
      ),
    );
  },
);

pagesRoute.post(':id/access', async (c) => {
  const pageId = c.req.param('id');
  const shareToken = getPresentedShareToken(c);
  const user = c.get('user') as { id: string };
  const result = await db.transaction(async (tx) => {
    // Link enable/disable, hierarchy changes, and provenance visits all use the
    // same workspace lock. The source lookup below therefore remains valid
    // through the conditional event inserts.
    await lockEntityAccess(tx, 'page', pageId);
    const page = await getPageById(pageId, tx);
    if (!page) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const linkAccesses = await getPageLinkAccesses(pageId, tx);
    const linkAccess = findPageLinkAccessByToken(linkAccesses, shareToken);
    const hasAccountAccess = await hasNonLinkPageAccess(page.id, user.id, tx);
    if (!hasAccountAccess && !linkAccess) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    let recordedLinkAccess = false;
    let linkAccessSource: 'page' | 'folder' | null = null;

    // Record every active link source even when an account grant currently
    // wins. Each source can become the fallback after a later revoke/expiry.
    const recordableLinkAccesses = linkAccess
      ? linkAccesses.filter(
          (candidate) => candidate.source === 'page' && candidate.token === linkAccess.token,
        )
      : [];
    if (recordableLinkAccesses.length > 0 && page.ownerId !== user.id) {
      recordedLinkAccess = true;
      linkAccessSource = 'page';
      const insertedAny = await recordPageLinkAccesses(
        tx,
        page.id,
        user.id,
        recordableLinkAccesses,
      );
      if (insertedAny) {
        await notifyShareRecompute(
          {
            entityType: 'page',
            entityId: page.id,
            targetUserId: user.id,
            metaUserIds: [user.id],
            metaOnly: true,
          },
          tx,
        );
      }
    }

    await executeQuery(
      tx,
      'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
      [user.id, pageId],
    );

    return { recordedLinkAccess, linkAccessSource };
  });

  return c.json({ ok: true, ...result });
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
    await lockWorkspaceAccessMutation(tx, user.id);
    const lockedPageResult = await executeQuery<{
      parent_id: string | null;
      created_by: string | null;
      owner_id: string | null;
    }>(
      tx,
      `select p.parent_id, p.created_by, ${deletedPageOwnerSql} as owner_id
       from pages p
       where p.id = $1 and p.is_deleted = true
       for update`,
      [pageId],
    );
    const lockedPage = lockedPageResult.rows[0];
    if (!lockedPage) {
      throw new HTTPException(404, { message: 'Page not found' });
    }
    if (lockedPage.owner_id !== user.id) {
      throw new HTTPException(403, { message: 'You can only restore pages that you own' });
    }
    const affectedBefore = await getEntityMetaUserIds(tx, 'page', pageId);

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
    const result = await executeQuery(
      tx,
      `update pages
       set is_deleted = false,
           deleted_at = null,
           deletion_batch_id = null,
           parent_id = $1,
           created_by = $2,
           position = $3,
           title_search = to_tsvector('english', title),
           updated_at = now()
       where id = $4 and is_deleted = true
      returning *`,
      [restoreParentId, restoreCreatorId, nextPosition, pageId],
    );
    if ((result.rowCount ?? 0) > 0) {
      const affectedAfter = await getEntityMetaUserIds(tx, 'page', pageId);
      const metaUserIds = mergeMetaUserIds(affectedBefore, affectedAfter);
      await notifyShareRecompute({ entityType: 'page', entityId: pageId, metaUserIds }, tx);
    }
    return result;
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
    const workspaceOwnerId = await lockEntityAccess(tx, 'page', pageId);
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
    const accessChanged = hasParentId && nextParent !== currentPage.parentId;
    if (accessChanged) {
      await lockWorkspaceAccessMutation(tx, workspaceOwnerId);
    }
    const affectedBefore = accessChanged ? await getEntityMetaUserIds(tx, 'page', pageId) : [];

    const result = hasProperties
      ? await executeQuery(
          tx,
          `update pages
           set title_revision = title_revision + case when title is distinct from $1 then 1 else 0 end,
               title = $1, title_search = to_tsvector('english', $1), icon = $2,
               parent_id = $3, position = $4, cover_type = $5, cover_value = $6,
               properties = $7, updated_at = now()
           where id = $8 returning *`,
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
          `update pages
           set title_revision = title_revision + case when title is distinct from $1 then 1 else 0 end,
               title = $1, title_search = to_tsvector('english', $1), icon = $2,
               parent_id = $3, position = $4, cover_type = $5, cover_value = $6,
               updated_at = now()
           where id = $7 returning *`,
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
    if (accessChanged) {
      const affectedAfter = await getEntityMetaUserIds(tx, 'page', pageId);
      await notifyShareRecompute(
        {
          entityType: 'page',
          entityId: pageId,
          metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
        },
        tx,
      );
    }
    return {
      result,
      enumerableFolderIds: await getEnumerableFolderIds(user.id, tx),
    };
  });

  const updated = normalizePageRow(updateResult.result.rows[0] as RawPageRow);
  return c.json(
    toPageDto(updated, redactParentId(updated.parentId, updateResult.enumerableFolderIds)),
  );
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
    const workspaceOwnerId = await lockEntityAccess(tx, 'page', pageId);
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) {
      throw new HTTPException(404, { message: 'Page not found' });
    }

    const nextParent = hasParentId ? (parentId ?? null) : currentPage.parentId;
    await ensurePageOrganizationAccess(currentPage, nextParent, user.id, tx);
    const nextPosition = normalizePosition(position, currentPage.position);
    const accessChanged = hasParentId && nextParent !== currentPage.parentId;
    if (accessChanged) {
      await lockWorkspaceAccessMutation(tx, workspaceOwnerId);
    }
    const affectedBefore = accessChanged ? await getEntityMetaUserIds(tx, 'page', pageId) : [];
    const result = await executeQuery(
      tx,
      'update pages set parent_id = $1, position = $2, updated_at = now() where id = $3 returning *',
      [nextParent, nextPosition, pageId],
    );

    if (result.rowCount === 0) {
      throw new HTTPException(500, { message: 'Failed to move page' });
    }

    if (accessChanged) {
      const affectedAfter = await getEntityMetaUserIds(tx, 'page', pageId);
      await notifyShareRecompute(
        {
          entityType: 'page',
          entityId: pageId,
          metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
        },
        tx,
      );
    }
    return {
      result,
      enumerableFolderIds: await getEnumerableFolderIds(user.id, tx),
    };
  });

  const updated = normalizePageRow(updateResult.result.rows[0] as RawPageRow);
  return c.json(
    toPageDto(updated, redactParentId(updated.parentId, updateResult.enumerableFolderIds)),
  );
});

pagesRoute.get(':id/export/markdown', async (c) => {
  const pageId = c.req.param('id');
  const user = c.get('user') as { id: string };
  const snapshot = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    const page = await getPageById(pageId, tx);
    if (!page) {
      throw new HTTPException(404, { message: 'Page not found' });
    }
    await ensurePageAccess(page.id, user.id, 'view', tx);
    const uploadResult = await executeQuery<{ filename: string }>(
      tx,
      `select u.filename
       from uploads u
       join upload_page_refs upr on upr.upload_id = u.id
       where upr.page_id = $1`,
      [pageId],
    );
    return {
      page,
      authorizedUploadFilenames: new Set(uploadResult.rows.map((row) => row.filename)),
    };
  });

  const { page, authorizedUploadFilenames } = snapshot;
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

  const updateResult = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    const currentPage = await getPageByIdForUpdate(pageId, tx);
    if (!currentPage) throw new HTTPException(404, { message: 'Page not found' });
    await ensurePageAccess(pageId, user.id, 'edit', tx);

    // Wiki links store authored paths only. A target UUID cannot be embedded
    // in the canonical Y.Doc because every page reader receives the same state.
    const ydocBuffer = Buffer.from(
      createYjsDocWithTitle(currentPage.title || 'Untitled', markdown),
    );
    ensureYdocSize(ydocBuffer);

    // The canonical content replacement invalidates every old source mapping.
    // Clear them atomically so click-time resolution cannot authorize a stale
    // target until the collaboration indexer processes this new document.
    await executeQuery(
      tx,
      `delete from connections where source_type = 'page' and source_id = $1`,
      [pageId],
    );

    return executeQuery(
      tx,
      `update pages
       set ydoc = $1,
           title_revision = title_revision + case when title is distinct from $2 then 1 else 0 end,
           title = $2,
           title_search = to_tsvector('english', $2),
           updated_at = now()
       where id = $3`,
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
    const metaUserIds = await getEntityMetaUserIds(tx, 'page', pageId);
    const updateResult = await executeQuery(
      tx,
      `update pages
       set is_deleted = true, deleted_at = now(), deletion_batch_id = gen_random_uuid(), updated_at = now()
       where id = $1`,
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
    await notifyShareRevoke({ entityType: 'page', entityId: pageId, metaUserIds }, tx);
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

    await notifyShareRevoke(
      {
        entityType: 'page',
        entityId: pageId,
        targetUserId: shareRow?.recipient_user_id ?? user.id,
        ...(ownerId ? { metaUserIds: [ownerId] } : {}),
      },
      tx,
    );
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
    await lockEntityAccessMutations(
      tx,
      [
        { entityType: 'page', entityId: pageId },
        ...(parentId ? [{ entityType: 'folder' as const, entityId: parentId }] : []),
      ],
      parentId ? [] : [user.id],
    );
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) throw new HTTPException(404, { message: 'Page not found' });
    await ensurePageAccess(pageId, user.id, 'view', tx);
    if (parentId) await ensureFolderAccess(parentId, user.id, 'admin', tx);

    const copiedTitle = createCopyPageTitle(currentPage.title);
    const copiedYdoc = prepareCopiedYdoc(currentPage.ydoc, copiedTitle);
    const nextPosition = await getNextPosition('pages', parentId ?? null, user.id, tx);
    const insertResult = await executeQuery(
      tx,
      `insert into pages (id, parent_id, title, title_search, icon, cover_type, cover_value, position, ydoc, properties, created_by)
       select gen_random_uuid(), $1, $2, to_tsvector('english', $2), icon, cover_type, cover_value, $3, $4, properties, $5
       from pages where id = $6 and is_deleted = false
       returning id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by, created_at, updated_at, is_deleted`,
      [parentId ?? null, copiedTitle, nextPosition, copiedYdoc, user.id, pageId],
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
    const metaUserIds = await getEntityMetaUserIds(tx, 'page', insertedPage.id);
    await notifyShareRecompute(
      {
        entityType: 'page',
        entityId: insertedPage.id,
        metaUserIds,
        metaOnly: true,
      },
      tx,
    );
    return insertedPage;
  });

  const created = normalizePageRow(copiedPage);
  return c.json({ ...created, ydoc: created.ydoc ? Array.from(created.ydoc) : null }, 201);
});

pagesRoute.delete(':id/permanent', async (c) => {
  const pageId = c.req.param('id');
  const user = c.get('user') as { id: string };
  const deletedPage = await getDeletedPageById(pageId);
  if (!deletedPage) {
    const activePage = await getPageById(pageId);
    if (activePage) {
      if (activePage.ownerId !== user.id) {
        throw new HTTPException(403, {
          message: 'You can only permanently delete pages that you own',
        });
      }
      throw new HTTPException(409, {
        message: 'Page must be moved to Trash before it can be permanently deleted',
      });
    }
    throw new HTTPException(404, { message: 'Page not found' });
  }

  if (deletedPage.ownerId !== user.id) {
    throw new HTTPException(403, {
      message: 'You can only permanently delete pages that you own',
    });
  }

  await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);
    const lockedPage = await executeQuery<{ owner_id: string | null }>(
      tx,
      `select ${deletedPageOwnerSql} as owner_id
       from pages p
       where p.id = $1 and p.is_deleted = true
       for update`,
      [pageId],
    );
    const ownerId = lockedPage.rows[0]?.owner_id;
    if (!ownerId) {
      throw new HTTPException(404, { message: 'Page not found' });
    }
    if (ownerId !== user.id) {
      throw new HTTPException(403, {
        message: 'You can only permanently delete pages that you own',
      });
    }
    await purgeUnreferencedUploadsForPages(tx, [pageId]);
    await purgeEntityAccessMetadata(tx, 'page', [pageId]);
    await executeQuery(tx, 'delete from pages where id = $1 and is_deleted = true', [pageId]);
  });
  await processUploadDeletionQueue();

  return c.json({ deleted: true });
});

export { pagesPublicRoute };
export default pagesRoute;
