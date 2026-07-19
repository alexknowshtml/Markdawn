import {
  deriveCapabilities,
  MAX_WIKI_LINK_PRESENTATION_REQUESTS,
  normalizeWikiLinkLookupKey,
  type WikiLinkPresentation,
  type WikiLinkPresentationRequest,
  type WikiLinkPresentationResponse,
} from '@markdawn/shared';
import { extractWikiLinkTargetIds } from '@markdawn/shared/yjs-helpers';
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
  ensureActorCanCreateInFolder,
  ensureActorPageAccess,
  getRequestActor,
  persistGuestIdentity,
} from '../utils/guestAccess';
import {
  bindWikiLinkTargets,
  createEmptyYjsDoc,
  createYjsDocWithTitle,
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
import { getUniqueWorkspacePageLookup } from '../utils/wiki-link-lookup';

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
  public_permission?: 'view' | 'edit' | null;
  inheritance_policy?: 'inherit' | 'restricted' | null;
  cover_type?: string | null;
  cover_value?: string | null;
};

type PublicPermission = 'view' | 'edit';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isLocalWikiLinkHeading = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith('#') && trimmed.slice(1).trim().length > 0;
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
  publicPermission: row.publicPermission ?? row.public_permission ?? null,
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
  publicPermission: page.publicPermission,
  inheritancePolicy: page.inheritancePolicy,
});

const toPublicPageDto = (
  page: NormalizedPageRow,
  publicPermission: PublicPermission,
  userPermission: SharePermission,
) => ({
  id: page.id,
  title: page.title,
  icon: page.icon,
  coverType: page.coverType,
  coverValue: page.coverValue,
  properties: page.properties,
  updatedAt: page.updatedAt,
  publicPermission,
  userPermission,
  capabilities: deriveCapabilities(userPermission),
});

const toPublicPageMetadataDto = (page: NormalizedPageRow) => ({
  id: page.id,
  title: page.title,
  icon: page.icon,
  coverType: page.coverType,
  coverValue: page.coverValue,
  properties: page.properties,
  updatedAt: page.updatedAt,
});

const getPagePublicPermission = async (
  pageId: string,
  executor?: QueryExecutor,
): Promise<PublicPermission | null> => {
  const statement = 'select get_public_page_permission($1) as permission';
  const result = executor
    ? await executeQuery<{ permission: PublicPermission | null }>(executor, statement, [pageId])
    : await query<{ permission: PublicPermission | null }>(statement, [pageId]);
  return result.rows[0]?.permission ?? null;
};

const hasAccountPageAccess = async (
  pageId: string,
  userId: string,
  executor: QueryExecutor,
): Promise<boolean> => {
  const result = await executeQuery<{ has_access: boolean }>(
    executor,
    `with page_info as (
       select coalesce(get_root_folder_owner(page.parent_id), page.created_by) as owner_id,
              page.parent_id
       from pages page
       where page.id = $1 and page.is_deleted = false
     )
     select exists (
       select 1 from page_info where owner_id = $2
       union all
       select 1 from shares share
       where share.entity_type = 'page'
         and share.entity_id = $1
         and share.recipient_user_id = $2
       union all
       select 1
       from page_info
       join shares share on share.entity_type = 'folder'
       join folders source_folder on source_folder.id = share.entity_id
       where share.entity_id in (
           select ancestor_id from folder_closure where descendant_id = page_info.parent_id
         )
         and share.recipient_user_id = $2
         and source_folder.is_deleted = false
         and not is_page_folder_inheritance_blocked(share.entity_id, $1)
       union all
       select 1
       from page_info
       join workspace_members member on member.workspace_owner_id = page_info.owner_id
       where member.member_id = $2
         and not is_page_path_restricted($1)
     ) as has_access`,
    [pageId, userId],
  );
  return result.rows[0]?.has_access === true;
};

const recordPagePublicVisit = async (
  executor: QueryExecutor,
  pageId: string,
  userId: string,
): Promise<boolean> => {
  const result = await executeQuery(
    executor,
    `insert into page_public_access_visits (page_id, user_id, first_seen_at, last_seen_at)
     values ($1, $2, now(), now())
     on conflict (page_id, user_id)
     do update set last_seen_at = excluded.last_seen_at
     returning (xmax = 0) as inserted`,
    [pageId, userId],
  );
  return result.rows[0]?.inserted === true;
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

pagesPublicRoute.post(
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

    const actor = await getRequestActor(c);
    if (!parentId && actor.kind === 'guest') {
      throw new HTTPException(401, { message: 'Log in to create a root page' });
    }

    const pageTitle = typeof title === 'string' ? normalizePageTitle(title) : 'Untitled';
    const ydocBuffer = Buffer.from(createEmptyYjsDoc(pageTitle));
    ensureYdocSize(ydocBuffer);

    const insertResult = await db.transaction(async (tx) => {
      if (parentId) {
        await lockEntityAccessMutation(tx, 'folder', parentId);
        await ensureActorCanCreateInFolder(actor, parentId, tx);
      } else {
        await lockWorkspaceAccessMutation(tx, actor.id);
      }
      await persistGuestIdentity(actor, tx);

      const nextPosition = await getNextPosition('pages', parentId ?? null, actor.id, tx);
      const result = await executeQuery(
        tx,
        "insert into pages (parent_id, title, title_search, icon, position, created_by, ydoc) values ($1, $2, to_tsvector('english', $2), $3, $4, $5, $6) returning *",
        [
          parentId ?? null,
          pageTitle,
          typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : null,
          nextPosition,
          actor.kind === 'user' ? actor.id : null,
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
  ':id/metadata',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ message: 'Request body is too large' }, 413),
  }),
  async (c) => {
    const pageId = c.req.param('id');
    const actor = await getRequestActor(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new HTTPException(400, { message: 'Invalid body' });
    }
    if (Object.hasOwn(body, 'parentId') || Object.hasOwn(body, 'position')) {
      throw new HTTPException(403, { message: 'Editor access cannot reorganize pages' });
    }
    const { title, icon, coverType, coverValue, properties } = body as {
      title?: unknown;
      icon?: unknown;
      coverType?: unknown;
      coverValue?: unknown;
      properties?: unknown;
    };
    const hasTitle = Object.hasOwn(body, 'title');
    const hasIcon = Object.hasOwn(body, 'icon');
    const hasCoverType = Object.hasOwn(body, 'coverType');
    const hasCoverValue = Object.hasOwn(body, 'coverValue');
    const hasProperties = Object.hasOwn(body, 'properties');

    const result = await db.transaction(async (tx) => {
      await lockEntityAccess(tx, 'page', pageId);
      await ensureActorPageAccess(actor, pageId, 'edit', tx);
      await persistGuestIdentity(actor, tx);
      const page = await getPageById(pageId, tx);
      if (!page) throw new HTTPException(404, { message: 'Page not found' });
      const nextTitle = hasTitle
        ? typeof title === 'string'
          ? normalizePageTitle(title)
          : (() => {
              throw new HTTPException(400, { message: 'title must be a string' });
            })()
        : page.title;
      const nextIcon = hasIcon
        ? typeof icon === 'string' && icon.trim().length > 0
          ? icon.trim()
          : icon === null || icon === ''
            ? null
            : (() => {
                throw new HTTPException(400, { message: 'icon must be a string or null' });
              })()
        : page.icon;
      const normalizeOptionalText = (value: unknown, field: string): string | null => {
        if (value === null || value === '') return null;
        if (typeof value !== 'string') {
          throw new HTTPException(400, { message: `${field} must be a string or null` });
        }
        return value.trim() || null;
      };
      const nextCoverType = hasCoverType
        ? normalizeOptionalText(coverType, 'coverType')
        : page.coverType;
      const nextCoverValue = hasCoverValue
        ? normalizeOptionalText(coverValue, 'coverValue')
        : page.coverValue;
      if (
        hasProperties &&
        properties !== null &&
        (typeof properties !== 'object' || Array.isArray(properties))
      ) {
        throw new HTTPException(400, { message: 'properties must be an object or null' });
      }
      const nextProperties = hasProperties ? JSON.stringify(properties) : page.properties;
      const updated = await executeQuery(
        tx,
        `update pages
         set title_revision = title_revision + case when title is distinct from $1 then 1 else 0 end,
             title = $1, title_search = to_tsvector('english', $1), icon = $2,
             cover_type = $3, cover_value = $4, properties = $5, updated_at = now()
         where id = $6
         returning *`,
        [nextTitle, nextIcon, nextCoverType, nextCoverValue, nextProperties, pageId],
      );
      if (page.title !== nextTitle) {
        await executeQuery(tx, 'select pg_notify($1, $2)', [
          'page_renamed',
          JSON.stringify({ pageId }),
        ]);
      }
      return normalizePageRow(updated.rows[0] as RawPageRow);
    });
    return c.json(toPublicPageMetadataDto(result));
  },
);

pagesPublicRoute.patch(
  ':id/title',
  bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => c.json({ message: 'Request body is too large' }, 413),
  }),
  async (c) => {
    const pageId = c.req.param('id');
    const actor = await getRequestActor(c);
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
      await ensureActorPageAccess(actor, pageId, 'edit', tx);
      await persistGuestIdentity(actor, tx);

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

pagesPublicRoute.post(
  ':id/wiki-link-presentations',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ message: 'Request body is too large' }, 413),
  }),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const sourcePageId = c.req.param('id');
    if (!UUID_PATTERN.test(sourcePageId)) {
      throw new HTTPException(400, { message: 'A valid source page is required' });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }
    const rawLinks =
      body && typeof body === 'object' && 'links' in body
        ? (body as { links?: unknown }).links
        : undefined;
    if (
      !Array.isArray(rawLinks) ||
      rawLinks.length === 0 ||
      rawLinks.length > MAX_WIKI_LINK_PRESENTATION_REQUESTS
    ) {
      throw new HTTPException(400, {
        message: `links must contain between 1 and ${MAX_WIKI_LINK_PRESENTATION_REQUESTS} items`,
      });
    }

    const links: WikiLinkPresentationRequest[] = [];
    const keys = new Set<string>();
    for (const rawLink of rawLinks) {
      if (!rawLink || typeof rawLink !== 'object') {
        throw new HTTPException(400, { message: 'Each link must be an object' });
      }
      const key = 'key' in rawLink ? rawLink.key : undefined;
      const targetId = 'targetId' in rawLink ? rawLink.targetId : undefined;
      const path = 'path' in rawLink ? rawLink.path : undefined;
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        key.length > 128 ||
        keys.has(key) ||
        (targetId !== undefined &&
          (typeof targetId !== 'string' || !UUID_PATTERN.test(targetId))) ||
        (path !== undefined && (typeof path !== 'string' || path.length > 1_000)) ||
        (targetId === undefined &&
          (typeof path !== 'string' ||
            (!normalizeWikiLinkLookupKey(path) && !isLocalWikiLinkHeading(path))))
      ) {
        throw new HTTPException(400, { message: 'Each link needs a unique key and valid target' });
      }
      keys.add(key);
      links.push({
        key,
        ...(typeof targetId === 'string' && { targetId: targetId.toLowerCase() }),
        ...(typeof path === 'string' && { path }),
      });
    }

    const actor = await getRequestActor(c);
    const response = await db.transaction(async (tx): Promise<WikiLinkPresentationResponse> => {
      await lockEntityAccess(tx, 'page', sourcePageId);
      await ensureActorPageAccess(actor, sourcePageId, 'view', tx);
      const sourceResult = await executeQuery<{ owner_id: string | null }>(
        tx,
        `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id
         from pages where id = $1 and is_deleted = false`,
        [sourcePageId],
      );
      const ownerId = sourceResult.rows[0]?.owner_id;
      if (!ownerId) throw new HTTPException(404, { message: 'Page not found' });

      const pathKeys = [
        ...new Set(
          links
            .filter((link) => !link.targetId && link.path)
            .map((link) => normalizeWikiLinkLookupKey(link.path ?? ''))
            .filter(Boolean),
        ),
      ];
      const mappedTargets = new Map<string, string>();
      if (pathKeys.length > 0) {
        const mapped = await executeQuery<{ target_slug: string; target_id: string }>(
          tx,
          `select target_slug, min(target_id::text)::uuid as target_id
           from connections
           where source_type = 'page' and source_id = $1
             and target_type = 'page' and target_id is not null
             and target_slug = any($2::text[])
             and connection_type in ('wikilink', 'heading')
           group by target_slug
           having count(distinct target_id) = 1`,
          [sourcePageId, pathKeys],
        );
        for (const row of mapped.rows) mappedTargets.set(row.target_slug, row.target_id);
      }

      const autoLookup = new Map<string, string>();
      if (pathKeys.length > 0) {
        if (actor.kind === 'user') {
          const requesterLookup = await getUniqueWorkspacePageLookup(ownerId, actor.id, tx);
          for (const pathKey of pathKeys) {
            const pageId = requesterLookup.get(pathKey);
            if (pageId) autoLookup.set(pathKey, pageId);
          }
        } else {
          const publicPages = await executeQuery<{ id: string; title: string }>(
            tx,
            `select p.id, p.title
             from pages p
             where p.is_deleted = false
               and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $1
               and get_public_page_permission(p.id) is not null`,
            [ownerId],
          );
          const publicByTitle = new Map<string, string[]>();
          for (const page of publicPages.rows) {
            const lookupKey = normalizeWikiLinkLookupKey(page.title);
            const ids = publicByTitle.get(lookupKey) ?? [];
            ids.push(page.id);
            publicByTitle.set(lookupKey, ids);
          }
          for (const pathKey of pathKeys) {
            const ids = publicByTitle.get(pathKey);
            if (ids?.length === 1 && ids[0]) autoLookup.set(pathKey, ids[0]);
          }
        }
      }

      const candidateByKey = new Map<string, { id: string }>();
      for (const link of links) {
        if (link.targetId) {
          candidateByKey.set(link.key, { id: link.targetId });
          continue;
        }
        const pathKey = normalizeWikiLinkLookupKey(link.path ?? '');
        if (!pathKey && isLocalWikiLinkHeading(link.path ?? '')) {
          candidateByKey.set(link.key, { id: sourcePageId });
          continue;
        }
        const mappedId = mappedTargets.get(pathKey);
        const automaticId = autoLookup.get(pathKey);
        const candidateId = mappedId ?? automaticId;
        if (candidateId) {
          candidateByKey.set(link.key, { id: candidateId });
        }
      }

      const candidateIds = [...new Set([...candidateByKey.values()].map(({ id }) => id))];
      const knownTargets = new Map<string, { id: string; title: string; accessible: boolean }>();
      if (candidateIds.length > 0) {
        const targets = await executeQuery<{ id: string; title: string; accessible: boolean }>(
          tx,
          `select target.id, target.title,
                  case
                    when $3::uuid is not null then exists (
                      select 1 from get_effective_page_permission(target.id, $3::uuid) access
                      where access.permission is not null
                    )
                    else get_public_page_permission(target.id) is not null
                  end as accessible
           from pages target
           where target.id = any($1::uuid[])
             and target.is_deleted = false
             and coalesce(get_root_folder_owner(target.parent_id), target.created_by) = $2`,
          [candidateIds, ownerId, actor.kind === 'user' ? actor.id : null],
        );
        for (const target of targets.rows) knownTargets.set(target.id, target);
      }

      const presentations: WikiLinkPresentation[] = links.map((link) => {
        const candidate = candidateByKey.get(link.key);
        if (!candidate) return { key: link.key, state: 'unavailable' };
        const target = knownTargets.get(candidate.id);
        if (!target) return { key: link.key, state: 'unavailable' };
        if (target.accessible) {
          return {
            key: link.key,
            state: 'accessible',
            target: { id: target.id, title: target.title },
          };
        }
        return { key: link.key, state: 'restricted' };
      });
      return { links: presentations };
    });

    return c.json(response);
  },
);

pagesPublicRoute.get(
  ':id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}',
  async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    const pageId = c.req.param('id');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const sessionUserId = session?.user ? (session.user as { id: string }).id : null;
    const result = await db.transaction(async (tx) => {
      await lockEntityAccess(tx, 'page', pageId);
      const page = await getPageById(pageId, tx);
      if (!page) {
        throw new HTTPException(404, { message: 'Page not found' });
      }

      const publicPermission = await getPagePublicPermission(pageId, tx);
      const hasAccountAccess = sessionUserId
        ? await hasAccountPageAccess(pageId, sessionUserId, tx)
        : false;
      let userPermission: SharePermission;
      let fullAccess = false;
      if (sessionUserId) {
        const access = await ensurePageAccess(pageId, sessionUserId, 'view', tx);
        userPermission = access.permission;
        fullAccess = access.fullAccess;
      } else {
        if (!publicPermission) {
          throw new HTTPException(401, { message: 'Log in to access this page' });
        }
        userPermission = publicPermission;
      }

      if (sessionUserId) {
        await executeQuery(
          tx,
          'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
          [sessionUserId, pageId],
        );
        if (publicPermission && page.ownerId !== sessionUserId) {
          await recordPagePublicVisit(tx, pageId, sessionUserId);
        }
      }

      const enumerableFolderIds =
        sessionUserId && hasAccountAccess
          ? await getEnumerableFolderIds(sessionUserId, tx)
          : new Set<string>();

      if (!hasAccountAccess) {
        if (!publicPermission) {
          throw new HTTPException(403, { message: 'You do not have public access to this page' });
        }
        return toPublicPageDto(page, publicPermission, userPermission);
      }

      return {
        ...toPageDto(page, redactParentId(page.parentId, enumerableFolderIds)),
        publicPermission,
        userPermission,
        capabilities: deriveCapabilities(userPermission, fullAccess),
      };
    });

    return c.json(result);
  },
);

pagesRoute.post(':id/access', async (c) => {
  const pageId = c.req.param('id');
  const user = c.get('user') as { id: string };
  await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    const page = await getPageById(pageId, tx);
    if (!page) throw new HTTPException(404, { message: 'Page not found' });
    await ensurePageAccess(pageId, user.id, 'view', tx);
    if ((await getPagePublicPermission(pageId, tx)) && page.ownerId !== user.id) {
      await recordPagePublicVisit(tx, pageId, user.id);
    }
    await executeQuery(
      tx,
      'insert into page_visits (user_id, page_id, visited_at) values ($1, $2, now()) on conflict (user_id, page_id) do update set visited_at = excluded.visited_at',
      [user.id, pageId],
    );
  });

  return c.json({ ok: true });
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
    const targetIds = page.ydoc
      ? extractWikiLinkTargetIds(new Uint8Array(page.ydoc)).filter((targetId) =>
          UUID_PATTERN.test(targetId),
        )
      : [];
    const ownerId =
      page.ownerId ??
      (
        await executeQuery<{ owner_id: string | null }>(
          tx,
          `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id
           from pages where id = $1`,
          [pageId],
        )
      ).rows[0]?.owner_id;
    if (!ownerId) throw new HTTPException(404, { message: 'Page not found' });
    const targetResult =
      targetIds.length > 0
        ? await executeQuery<{ id: string; title: string }>(
            tx,
            `select p.id, p.title
             from pages p
             where p.id = any($1::uuid[])
               and p.is_deleted = false
               and p.id in (select page_id from get_accessible_page_ids($2))
               and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $3`,
            [targetIds, user.id, ownerId],
          )
        : { rows: [] };
    return {
      page,
      authorizedUploadFilenames: new Set(uploadResult.rows.map((row) => row.filename)),
      wikiLinkTargets: new Map(targetResult.rows.map((target) => [target.id, target.title])),
    };
  });

  const { page, authorizedUploadFilenames, wikiLinkTargets } = snapshot;
  const baseFilename = slugifyFilename(page.title || 'Untitled') || 'untitled';
  const markdown = pageToMarkdown(page.ydoc, page.properties, page.icon, page.title || undefined, {
    resolveWikiLinkTarget: (targetId) => {
      const title = wikiLinkTargets.get(targetId.toLowerCase());
      return title ? { title } : null;
    },
    restrictedWikiLinkText: 'Restricted page',
  });
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

    const ownerId =
      currentPage.ownerId ??
      (
        await executeQuery<{ owner_id: string | null }>(
          tx,
          `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id
           from pages where id = $1`,
          [pageId],
        )
      ).rows[0]?.owner_id;
    if (!ownerId) throw new HTTPException(404, { message: 'Page not found' });
    const pageLookup = await getUniqueWorkspacePageLookup(ownerId, user.id, tx);
    const ydocBuffer = Buffer.from(
      bindWikiLinkTargets(
        createYjsDocWithTitle(currentPage.title || 'Untitled', markdown),
        pageLookup,
      ),
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
      'delete from page_public_access_visits where page_id = $1 and user_id = $2 returning id',
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

pagesPublicRoute.post(':id/copy', async (c) => {
  const pageId = c.req.param('id');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch(() => null);
  const parentId =
    body && typeof body === 'object'
      ? ((body as { parentId?: string | null }).parentId ?? null)
      : null;
  if (!parentId && actor.kind === 'guest') {
    throw new HTTPException(401, { message: 'Log in to copy a page to the workspace root' });
  }

  const copiedPage = await db.transaction(async (tx) => {
    await lockEntityAccessMutations(
      tx,
      [
        { entityType: 'page', entityId: pageId },
        ...(parentId ? [{ entityType: 'folder' as const, entityId: parentId }] : []),
      ],
      parentId ? [] : [actor.id],
    );
    const currentPage = await getPageById(pageId, tx);
    if (!currentPage) throw new HTTPException(404, { message: 'Page not found' });
    await ensureActorPageAccess(actor, pageId, 'view', tx);
    if (parentId) await ensureActorCanCreateInFolder(actor, parentId, tx);
    await persistGuestIdentity(actor, tx);

    const destinationOwnerId = parentId
      ? (
          await executeQuery<{ owner_id: string | null }>(
            tx,
            'select get_root_folder_owner($1) as owner_id',
            [parentId],
          )
        ).rows[0]?.owner_id
      : actor.kind === 'user'
        ? actor.id
        : null;
    if (!destinationOwnerId) {
      throw new HTTPException(404, { message: 'Destination workspace not found' });
    }
    const preservePageConnectionIndex = currentPage.ownerId === destinationOwnerId;

    const copiedTitle = createCopyPageTitle(currentPage.title);
    const copiedYdoc = prepareCopiedYdoc(currentPage.ydoc, copiedTitle);
    const nextPosition = await getNextPosition('pages', parentId ?? null, actor.id, tx);
    const insertResult = await executeQuery(
      tx,
      `insert into pages (id, parent_id, title, title_search, icon, cover_type, cover_value, position, ydoc, properties, created_by)
       select gen_random_uuid(), $1, $2, to_tsvector('english', $2), icon, cover_type, cover_value, $3, $4, properties, $5
       from pages where id = $6 and is_deleted = false
       returning id, parent_id, title, icon, cover_type, cover_value, position, ydoc, created_by, created_at, updated_at, is_deleted`,
      [
        parentId ?? null,
        copiedTitle,
        nextPosition,
        copiedYdoc,
        actor.kind === 'user' ? actor.id : null,
        pageId,
      ],
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
       where source_type = 'page' and source_id = $2
         and ($3::boolean or target_type <> 'page')`,
      [insertedPage.id, pageId, preservePageConnectionIndex],
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
