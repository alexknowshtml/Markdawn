import {
  deriveCapabilities,
  type EntityAccessor,
  type EntityAccessSource,
  getApiLogger,
  type InheritedPublicLink,
} from '@markdawn/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { sendShareInviteEmail } from '../utils/email';
import { getEnumerableFolderIds, redactParentId } from '../utils/folderEnumeration';
import {
  ensureCanAdminEntity,
  ensureFolderAccess,
  ensurePageAccess,
  lockEntityAccess,
  lockEntityAccessMutation,
  parseEntityType,
  parseLinkPermission,
  parsePermission,
  type ShareEntityType,
  type SharePermission,
} from '../utils/share-access';
import {
  notifyShareGrant,
  notifyShareRecompute,
  notifyShareRevoke,
  notifyShareUpdate,
} from '../utils/share-notify';
import { getEntityMetaUserIds, mergeMetaUserIds } from '../utils/shareRecipients';

type EntityInfo = {
  id: string;
  ownerId?: string | null;
  title: string;
  inheritancePolicy: 'inherit' | 'restricted';
};

type ShareRow = {
  id: string;
  entity_type: ShareEntityType;
  entity_id: string;
  permission: SharePermission;
  token: string | null;
  recipient_user_id: string | null;
  recipient_email: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  shared_by_name: string | null;
  shared_by_email: string | null;
  recipient_name: string | null;
  recipient_avatar_url: string | null;
};

type AccessorRow = {
  share_id: string | null;
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  permission: SharePermission;
  source: string;
};

type AccessorWithFolderSource = EntityAccessor & {
  sourceFolderId?: string;
};

type SharedWithMeRow = ShareRow & {
  entity_title: string | null;
  entity_icon: string | null;
  owner_id: string | null;
  entity_updated_at: Date | null;
  sort_at: Date | null;
  source: 'direct' | 'link';
};

type SharedNavigationPage = {
  entityType: 'page';
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  ownerId: string | null;
  createdBy: string | null;
  updatedAt: Date | null;
  userPermission: SharePermission | null;
  source?: 'direct' | 'link';
  sortAt?: Date | null;
};

type SharedNavigationFolder = {
  entityType: 'folder';
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  ownerId: string | null;
  createdBy: string | null;
  updatedAt: Date | null;
  userPermission: SharePermission | null;
  source?: 'direct' | 'link';
  sortAt?: Date | null;
  children: SharedNavigationItem[];
};

type SharedNavigationItem = SharedNavigationPage | SharedNavigationFolder;

type SharedNavigationFolderRow = {
  root_id: string;
  id: string;
  parent_id: string | null;
  name: string | null;
  icon: string | null;
  position: string | null;
  created_by: string | null;
  updated_at: Date | null;
  owner_id: string | null;
  user_permission: SharePermission | null;
};

type SharedNavigationPageRow = {
  root_id: string | null;
  id: string;
  parent_id: string | null;
  title: string | null;
  icon: string | null;
  position: string | null;
  created_by: string | null;
  updated_at: Date | null;
  owner_id: string | null;
  user_permission: SharePermission | null;
};

const slugifyTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildPagePath = (title: string, pageId: string) =>
  `/app/${slugifyTitle(title) || 'page'}-${pageId}`;

const buildFolderPath = (name: string, folderId: string) =>
  `/app/folder/${slugifyTitle(name) || 'folder'}-${folderId}`;

const appendShareToken = (path: string, token: string) =>
  `${path}?share=${encodeURIComponent(token)}`;

const sharesRoute = new Hono();

async function lockShareMutation(
  executor: QueryExecutor,
  entityType: ShareEntityType,
  entityId: string,
): Promise<void> {
  await lockEntityAccessMutation(executor, entityType, entityId);
}

const parseShareExpiration = (value: unknown, nowTimestamp: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HTTPException(400, {
      message: 'Expiration must be a valid date',
      cause: { code: 'INVALID_EXPIRATION' },
    });
  }

  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new HTTPException(400, {
      message: 'Expiration must be a valid date',
      cause: { code: 'INVALID_EXPIRATION' },
    });
  }
  if (timestamp <= nowTimestamp) {
    throw new HTTPException(400, {
      message: 'Expiration must be in the future',
      cause: { code: 'EXPIRATION_NOT_FUTURE' },
    });
  }
  return new Date(timestamp).toISOString();
};

sharesRoute.use('*', requireAuth);

const normalizeShare = (row: ShareRow) => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  permission: row.permission,
  token: row.token,
  recipientUserId: row.recipient_user_id,
  recipientEmail: row.recipient_email,
  recipientName: row.recipient_name,
  recipientAvatarUrl: row.recipient_avatar_url,
  sharedByName: row.shared_by_name,
  sharedByEmail: row.shared_by_email,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toCollaboratorPresence = (accessors: readonly EntityAccessor[], requestingUserId: string) =>
  accessors
    .filter((accessor) => accessor.userId !== requestingUserId)
    .map((_accessor, index) => ({
      presenceId: `presence-${index + 1}`,
      name: null,
      avatarUrl: null,
    }));

const redactAccessorFolderSources = (
  accessors: readonly AccessorWithFolderSource[],
  enumerableFolderIds: ReadonlySet<string>,
): EntityAccessor[] =>
  accessors.map((accessor) => {
    const redacted: AccessorWithFolderSource = { ...accessor };
    if (redacted.sourceFolderId && !enumerableFolderIds.has(redacted.sourceFolderId)) {
      redacted.source = 'Inherited folder';
    }
    delete redacted.sourceFolderId;
    return redacted;
  });

const permissionRank = (permission: SharePermission) =>
  permission === 'admin' ? 3 : permission === 'edit' ? 2 : 1;

const getPageAccessors = async (
  pageId: string,
  executor: QueryExecutor = db,
): Promise<AccessorWithFolderSource[]> => {
  const rank = (p: SharePermission) => (p === 'admin' ? 3 : p === 'edit' ? 2 : 1);

  // With container-owned permissions, the page's effective owner is the
  // folder it lives in (or the page creator for root-level pages).
  const ownerResult = await executeQuery(
    executor,
    `
      select
        coalesce(get_root_folder_owner(p.parent_id), p.created_by) as user_id,
        u.name,
        u.email,
        coalesce(u.avatar_url, u.image) as avatar_url
      from pages p
      join users u on u.id = coalesce(get_root_folder_owner(p.parent_id), p.created_by)
      where p.id = $1 and p.is_deleted = false
    `,
    [pageId],
  );
  const ownerRow = ownerResult.rows[0] as
    | { user_id: string; name: string | null; email: string | null; avatar_url: string | null }
    | undefined;

  const [inviteResult, , folderInviteResult, workspaceMemberResult] = await Promise.all([
    executeQuery(
      executor,
      `
          select
            s.id as share_id,
            s.recipient_user_id as user_id,
            recipient.name,
            recipient.email,
            coalesce(recipient.avatar_url, recipient.image) as avatar_url,
            s.permission,
            'Email' as source
          from shares s
          join users recipient on recipient.id = s.recipient_user_id
          where s.entity_type = 'page'
            and s.entity_id = $1
            and s.recipient_user_id is not null
            and s.token is null
            and s.recipient_user_id != $2
            and (s.expires_at is null or s.expires_at > statement_timestamp())
        `,
      [pageId, ownerRow?.user_id ?? ''],
    ),
    executeQuery(
      executor,
      `
          SELECT permission
          FROM (
            SELECT s.permission, 0 AS priority, 0 AS depth
            FROM shares s
            JOIN pages p ON p.id = s.entity_id AND p.is_public = true AND p.is_deleted = false
            WHERE s.entity_type = 'page'
              AND s.entity_id = $1
              AND s.token IS NOT NULL
              AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())

            UNION ALL

            SELECT s.permission, 1 AS priority, fc.depth
            FROM pages p
            JOIN folder_closure fc ON fc.descendant_id = p.parent_id
            JOIN folders f ON f.id = fc.ancestor_id AND f.is_public = true AND f.is_deleted = false
            JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
            WHERE p.id = $1
              AND p.is_deleted = false
              AND s.token IS NOT NULL
              AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
              AND NOT is_page_folder_inheritance_blocked(f.id, p.id)
          ) link_permissions
          ORDER BY CASE permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
                   priority ASC,
                   depth ASC
          LIMIT 1
        `,
      [pageId],
    ),
    executeQuery(
      executor,
      `
          SELECT
            s.id as share_id,
            s.recipient_user_id as user_id,
            recipient.name,
            recipient.email,
            coalesce(recipient.avatar_url, recipient.image) as avatar_url,
            s.permission,
            f.id as folder_id,
            f.name as folder_name
          FROM shares s
          JOIN users recipient ON recipient.id = s.recipient_user_id
          JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
          JOIN pages p ON p.id = $1 AND p.is_deleted = false
          JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false
          WHERE s.entity_type = 'folder'
            AND fc.descendant_id = p.parent_id
            AND s.recipient_user_id IS NOT NULL
            AND s.token IS NULL
            AND s.recipient_user_id != $2
            AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
            AND NOT is_page_folder_inheritance_blocked(s.entity_id, $1)
        `,
      [pageId, ownerRow?.user_id ?? ''],
    ),
    executeQuery(
      executor,
      `
          SELECT wm.member_id, u.name, u.email, coalesce(u.avatar_url, u.image) as avatar_url,
                 CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END AS permission
          FROM workspace_members wm
          JOIN users u ON u.id = wm.member_id
          WHERE wm.workspace_owner_id = (
            SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by)
            FROM pages p
            WHERE p.id = $1
          )
          AND wm.member_id != $2
          AND NOT is_page_path_restricted($1)
        `,
      [pageId, ownerRow?.user_id ?? ''],
    ),
  ]);

  const result: AccessorWithFolderSource[] = [];

  if (ownerRow) {
    result.push({
      shareId: null,
      userId: ownerRow.user_id,
      name: ownerRow.name,
      email: ownerRow.email,
      avatarUrl: ownerRow.avatar_url,
      permission: 'edit',
      source: 'owner',
      isOwner: true,
    });
  }

  const userPermissions = new Map<
    string,
    {
      permission: SharePermission;
      source: string;
      shareId: string | null;
      sourceFolderId?: string;
    }
  >();
  const userInfo = new Map<
    string,
    { name: string | null; email: string | null; avatarUrl: string | null }
  >();

  for (const row of inviteResult.rows) {
    const item = row as AccessorRow & { avatar_url: string | null };
    userInfo.set(item.user_id, {
      name: item.name,
      email: item.email,
      avatarUrl: item.avatar_url,
    });
    userPermissions.set(item.user_id, {
      permission: item.permission,
      source: 'Email',
      shareId: item.share_id,
    });
  }

  for (const row of folderInviteResult.rows) {
    const item = row as AccessorRow & {
      avatar_url: string | null;
      folder_id: string;
      folder_name: string;
    };
    const existing = userPermissions.get(item.user_id);
    const folderPerm = item.permission as SharePermission;
    if (!existing || rank(folderPerm) > rank(existing.permission)) {
      userPermissions.set(item.user_id, {
        permission: folderPerm,
        source: `via ${item.folder_name}`,
        shareId: null,
        sourceFolderId: item.folder_id,
      });
      userInfo.set(item.user_id, {
        name: item.name,
        email: item.email,
        avatarUrl: item.avatar_url,
      });
    }
  }

  for (const row of workspaceMemberResult.rows) {
    const item = row as {
      member_id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
      permission: string;
    };
    const workspacePerm = item.permission as SharePermission;
    const existing = userPermissions.get(item.member_id);
    if (!existing || rank(workspacePerm) > rank(existing.permission)) {
      userPermissions.set(item.member_id, {
        permission: workspacePerm,
        source: 'Workspace Member',
        shareId: null,
      });
      userInfo.set(item.member_id, {
        name: item.name,
        email: item.email,
        avatarUrl: item.avatar_url,
      });
    }
  }

  for (const [userId, entry] of userPermissions) {
    const info = userInfo.get(userId);
    result.push({
      shareId: entry.shareId,
      userId,
      name: info?.name ?? null,
      email: info?.email ?? null,
      avatarUrl: info?.avatarUrl ?? null,
      permission: entry.permission,
      source: entry.source,
      isOwner: false,
      ...(entry.sourceFolderId ? { sourceFolderId: entry.sourceFolderId } : {}),
    });
  }

  return result;
};

const getFolderAccessors = async (
  folderId: string,
  executor: QueryExecutor = db,
): Promise<AccessorWithFolderSource[]> => {
  const ownerResult = await executeQuery(
    executor,
    `
      select get_root_folder_owner(f.id) as user_id, u.name, u.email, coalesce(u.avatar_url, u.image) as avatar_url
      from folders f
      join users u on u.id = get_root_folder_owner(f.id)
      where f.id = $1 and f.is_deleted = false
    `,
    [folderId],
  );
  const ownerRow = ownerResult.rows[0] as
    | { user_id: string; name: string | null; email: string | null; avatar_url: string | null }
    | undefined;

  const [inviteResult, , folderInviteResult, workspaceMemberResult] = await Promise.all([
    executeQuery(
      executor,
      `
          select
            s.id as share_id,
            s.recipient_user_id as user_id,
            recipient.name,
            recipient.email,
            coalesce(recipient.avatar_url, recipient.image) as avatar_url,
            s.permission,
            'Direct Invite' as source
          from shares s
          join users recipient on recipient.id = s.recipient_user_id
          where s.entity_type = 'folder'
            and s.entity_id = $1
            and s.recipient_user_id is not null
            and s.token is null
            and s.recipient_user_id != $2
            and (s.expires_at is null or s.expires_at > statement_timestamp())
        `,
      [folderId, ownerRow?.user_id ?? ''],
    ),
    executeQuery(
      executor,
      `
          SELECT s.permission
          FROM folder_closure fc
          JOIN folders f ON f.id = fc.ancestor_id AND f.is_public = true AND f.is_deleted = false
          JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
          WHERE fc.descendant_id = $1
            AND s.token IS NOT NULL
            AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
            AND NOT is_folder_inheritance_blocked(f.id, $1)
          ORDER BY CASE s.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
                   fc.depth ASC
          LIMIT 1
        `,
      [folderId],
    ),
    executeQuery(
      executor,
      `
          SELECT
            s.id as share_id,
            s.recipient_user_id as user_id,
            recipient.name,
            recipient.email,
            coalesce(recipient.avatar_url, recipient.image) as avatar_url,
            s.permission,
            f.id as folder_id,
            f.name as folder_name
          FROM shares s
          JOIN users recipient ON recipient.id = s.recipient_user_id
          JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
          JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false
          WHERE s.entity_type = 'folder'
            AND fc.descendant_id = $1
            AND fc.depth > 0
            AND s.recipient_user_id IS NOT NULL
            AND s.token IS NULL
            AND s.recipient_user_id != $2
            AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
            AND NOT is_folder_inheritance_blocked(s.entity_id, $1)
        `,
      [folderId, ownerRow?.user_id ?? ''],
    ),
    executeQuery(
      executor,
      `
          SELECT wm.member_id, u.name, u.email, coalesce(u.avatar_url, u.image) as avatar_url,
                 CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END AS permission
          FROM workspace_members wm
          JOIN users u ON u.id = wm.member_id
          WHERE wm.workspace_owner_id = get_root_folder_owner($1)
          AND wm.member_id != $2
          AND NOT is_folder_path_restricted($1)
        `,
      [folderId, ownerRow?.user_id ?? ''],
    ),
  ]);

  const rank = (p: SharePermission) => (p === 'admin' ? 3 : p === 'edit' ? 2 : 1);

  const result: AccessorWithFolderSource[] = [];

  if (ownerRow) {
    result.push({
      shareId: null,
      userId: ownerRow.user_id,
      name: ownerRow.name,
      email: ownerRow.email,
      avatarUrl: ownerRow.avatar_url,
      permission: 'edit',
      source: 'Owner',
      isOwner: true,
    });
  }

  const userPermissions = new Map<
    string,
    {
      permission: SharePermission;
      source: string;
      shareId: string | null;
      sourceFolderId?: string;
    }
  >();
  const userInfo = new Map<
    string,
    { name: string | null; email: string | null; avatarUrl: string | null }
  >();

  for (const row of inviteResult.rows) {
    const item = row as AccessorRow & { avatar_url: string | null };
    userInfo.set(item.user_id, {
      name: item.name,
      email: item.email,
      avatarUrl: item.avatar_url,
    });
    userPermissions.set(item.user_id, {
      permission: item.permission,
      source: 'Direct Invite',
      shareId: item.share_id,
    });
  }

  for (const row of folderInviteResult.rows) {
    const item = row as AccessorRow & {
      avatar_url: string | null;
      folder_id: string;
      folder_name: string;
    };
    const existing = userPermissions.get(item.user_id);
    const folderPerm = item.permission as SharePermission;
    if (!existing || rank(folderPerm) > rank(existing.permission)) {
      userPermissions.set(item.user_id, {
        permission: folderPerm,
        source: `via ${item.folder_name}`,
        shareId: null,
        sourceFolderId: item.folder_id,
      });
      userInfo.set(item.user_id, {
        name: item.name,
        email: item.email,
        avatarUrl: item.avatar_url,
      });
    }
  }

  for (const row of workspaceMemberResult.rows) {
    const item = row as {
      member_id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
      permission: string;
    };
    const workspacePerm = item.permission as SharePermission;
    const existing = userPermissions.get(item.member_id);
    if (!existing || rank(workspacePerm) > rank(existing.permission)) {
      userPermissions.set(item.member_id, {
        permission: workspacePerm,
        source: 'Workspace Member',
        shareId: null,
      });
      userInfo.set(item.member_id, {
        name: item.name,
        email: item.email,
        avatarUrl: item.avatar_url,
      });
    }
  }

  for (const [userId, entry] of userPermissions) {
    const info = userInfo.get(userId);
    result.push({
      shareId: entry.shareId,
      userId,
      name: info?.name ?? null,
      email: info?.email ?? null,
      avatarUrl: info?.avatarUrl ?? null,
      permission: entry.permission,
      source: entry.source,
      isOwner: false,
      ...(entry.sourceFolderId ? { sourceFolderId: entry.sourceFolderId } : {}),
    });
  }

  return result;
};

type AccessSourceRow = {
  kind: EntityAccessSource['kind'];
  share_id: string | null;
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  permission: SharePermission;
  effective_permission: SharePermission;
  folder_id: string | null;
  folder_name: string | null;
};

const normalizeAccessSources = (rows: AccessSourceRow[]): EntityAccessSource[] =>
  rows.map((row) => ({
    kind: row.kind,
    shareId: row.share_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    permission: row.permission,
    effectivePermission: row.effective_permission,
    isWinning: permissionRank(row.permission) === permissionRank(row.effective_permission),
    isOwner: row.kind === 'owner',
    isManageable: row.kind === 'direct',
    ...(row.folder_id !== null ? { folderId: row.folder_id } : {}),
    ...(row.folder_name !== null ? { folderName: row.folder_name } : {}),
  }));

const getPageAccessSources = async (
  pageId: string,
  executor: QueryExecutor = db,
): Promise<EntityAccessSource[]> => {
  const result = await executeQuery<AccessSourceRow>(
    executor,
    `
      WITH target AS (
        SELECT p.parent_id,
               COALESCE(get_root_folder_owner(p.parent_id), p.created_by) AS owner_id
        FROM pages p
        WHERE p.id = $1 AND p.is_deleted = false
      ), sources AS (
        SELECT 'owner'::text AS kind, NULL::uuid AS share_id, target.owner_id AS user_id,
               'edit'::text AS permission, NULL::uuid AS folder_id, NULL::text AS folder_name
        FROM target
        WHERE target.owner_id IS NOT NULL

        UNION ALL

        SELECT 'direct'::text, s.id, s.recipient_user_id, s.permission,
               NULL::uuid, NULL::text
        FROM shares s
        JOIN target ON true
        WHERE s.entity_type = 'page'
          AND s.entity_id = $1
          AND s.recipient_user_id IS NOT NULL
          AND s.recipient_user_id <> target.owner_id
          AND s.token IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())

        UNION ALL

        SELECT 'folder'::text, s.id, s.recipient_user_id, s.permission,
               f.id, f.name
        FROM target
        JOIN folder_closure fc ON fc.descendant_id = target.parent_id
        JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false
        JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
        WHERE s.recipient_user_id IS NOT NULL
          AND s.recipient_user_id <> target.owner_id
          AND s.token IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
          AND NOT is_page_folder_inheritance_blocked(f.id, $1)

        UNION ALL

        SELECT 'workspace'::text, NULL::uuid, wm.member_id,
               CASE wm.role
                 WHEN 'viewer' THEN 'view'
                 WHEN 'editor' THEN 'edit'
                 WHEN 'admin' THEN 'admin'
               END,
               NULL::uuid, NULL::text
        FROM target
        JOIN workspace_members wm ON wm.workspace_owner_id = target.owner_id
        WHERE wm.member_id <> target.owner_id
          AND NOT is_page_path_restricted($1)
      )
      SELECT sources.kind, sources.share_id, sources.user_id,
             u.name, u.email, COALESCE(u.avatar_url, u.image) AS avatar_url,
             sources.permission, access.permission AS effective_permission,
             sources.folder_id, sources.folder_name
      FROM sources
      JOIN users u ON u.id = sources.user_id
      JOIN LATERAL get_effective_page_permission($1, sources.user_id) access ON true
      WHERE access.permission IS NOT NULL
      ORDER BY CASE sources.kind
                 WHEN 'owner' THEN 0
                 WHEN 'direct' THEN 1
                 WHEN 'folder' THEN 2
                 ELSE 3
               END,
               LOWER(COALESCE(u.name, u.email, '')),
               sources.folder_name NULLS FIRST
    `,
    [pageId],
  );
  return normalizeAccessSources(result.rows);
};

const getFolderAccessSources = async (
  folderId: string,
  executor: QueryExecutor = db,
): Promise<EntityAccessSource[]> => {
  const result = await executeQuery<AccessSourceRow>(
    executor,
    `
      WITH target AS (
        SELECT get_root_folder_owner(f.id) AS owner_id
        FROM folders f
        WHERE f.id = $1 AND f.is_deleted = false
      ), sources AS (
        SELECT 'owner'::text AS kind, NULL::uuid AS share_id, target.owner_id AS user_id,
               'admin'::text AS permission, NULL::uuid AS folder_id, NULL::text AS folder_name
        FROM target
        WHERE target.owner_id IS NOT NULL

        UNION ALL

        SELECT 'direct'::text, s.id, s.recipient_user_id, s.permission,
               NULL::uuid, NULL::text
        FROM shares s
        JOIN target ON true
        WHERE s.entity_type = 'folder'
          AND s.entity_id = $1
          AND s.recipient_user_id IS NOT NULL
          AND s.recipient_user_id <> target.owner_id
          AND s.token IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())

        UNION ALL

        SELECT 'folder'::text, s.id, s.recipient_user_id, s.permission,
               f.id, f.name
        FROM target
        JOIN folder_closure fc ON fc.descendant_id = $1 AND fc.depth > 0
        JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false
        JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
        WHERE s.recipient_user_id IS NOT NULL
          AND s.recipient_user_id <> target.owner_id
          AND s.token IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
          AND NOT is_folder_inheritance_blocked(f.id, $1)

        UNION ALL

        SELECT 'workspace'::text, NULL::uuid, wm.member_id,
               CASE wm.role
                 WHEN 'viewer' THEN 'view'
                 WHEN 'editor' THEN 'edit'
                 WHEN 'admin' THEN 'admin'
               END,
               NULL::uuid, NULL::text
        FROM target
        JOIN workspace_members wm ON wm.workspace_owner_id = target.owner_id
        WHERE wm.member_id <> target.owner_id
          AND NOT is_folder_path_restricted($1)
      )
      SELECT sources.kind, sources.share_id, sources.user_id,
             u.name, u.email, COALESCE(u.avatar_url, u.image) AS avatar_url,
             sources.permission, access.permission AS effective_permission,
             sources.folder_id, sources.folder_name
      FROM sources
      JOIN users u ON u.id = sources.user_id
      JOIN LATERAL get_effective_folder_permission($1, sources.user_id) access ON true
      WHERE access.permission IS NOT NULL
      ORDER BY CASE sources.kind
                 WHEN 'owner' THEN 0
                 WHEN 'direct' THEN 1
                 WHEN 'folder' THEN 2
                 ELSE 3
               END,
               LOWER(COALESCE(u.name, u.email, '')),
               sources.folder_name NULLS FIRST
    `,
    [folderId],
  );
  return normalizeAccessSources(result.rows);
};

const getInheritedPublicLinks = async (
  entityType: ShareEntityType,
  entityId: string,
  executor: QueryExecutor = db,
): Promise<InheritedPublicLink[]> => {
  const result =
    entityType === 'page'
      ? await executeQuery<{
          entity_id: string;
          entity_title: string;
          permission: 'view' | 'edit';
          token: string;
        }>(
          executor,
          `
            SELECT f.id AS entity_id, f.name AS entity_title, s.permission, s.token
            FROM pages p
            JOIN folder_closure fc ON fc.descendant_id = p.parent_id
            JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false AND f.is_public = true
            JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
            WHERE p.id = $1
              AND p.is_deleted = false
              AND s.token IS NOT NULL
              AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
              AND NOT is_page_folder_inheritance_blocked(f.id, p.id)
            ORDER BY CASE s.permission WHEN 'edit' THEN 2 ELSE 1 END DESC, fc.depth ASC
          `,
          [entityId],
        )
      : await executeQuery<{
          entity_id: string;
          entity_title: string;
          permission: 'view' | 'edit';
          token: string;
        }>(
          executor,
          `
            SELECT f.id AS entity_id, f.name AS entity_title, s.permission, s.token
            FROM folder_closure fc
            JOIN folders f ON f.id = fc.ancestor_id AND f.is_deleted = false AND f.is_public = true
            JOIN shares s ON s.entity_type = 'folder' AND s.entity_id = f.id
            WHERE fc.descendant_id = $1
              AND fc.depth > 0
              AND s.token IS NOT NULL
              AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
              AND NOT is_folder_inheritance_blocked(f.id, $1)
            ORDER BY CASE s.permission WHEN 'edit' THEN 2 ELSE 1 END DESC, fc.depth ASC
          `,
          [entityId],
        );

  return result.rows.map((row) => ({
    entityId: row.entity_id,
    entityTitle: row.entity_title,
    permission: row.permission,
    token: row.token,
    url: buildFolderPath(row.entity_title, row.entity_id),
  }));
};

const resolveEntity = async (
  entityType: ShareEntityType,
  entityId: string,
  executor: QueryExecutor = db,
): Promise<EntityInfo> => {
  if (entityType === 'folder') {
    const result = await executeQuery(
      executor,
      'select id, get_root_folder_owner(id) as owner_id, name, inheritance_policy from folders where id = $1 and is_deleted = false',
      [entityId],
    );
    const row = result.rows[0] as
      | {
          id: string;
          owner_id?: string | null;
          name: string;
          inheritance_policy?: 'inherit' | 'restricted' | null;
        }
      | undefined;
    if (!row) {
      throw new HTTPException(404, { message: 'Folder not found' });
    }
    return {
      id: row.id,
      ownerId: row.owner_id ?? null,
      title: row.name,
      inheritancePolicy: row.inheritance_policy ?? 'inherit',
    };
  }

  const result = await executeQuery(
    executor,
    `select p.id, coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id, p.title, p.inheritance_policy
     from pages p
     where p.id = $1 and p.is_deleted = false`,
    [entityId],
  );
  const row = result.rows[0] as
    | {
        id: string;
        owner_id?: string | null;
        title: string;
        inheritance_policy?: 'inherit' | 'restricted' | null;
      }
    | undefined;
  if (!row) {
    throw new HTTPException(404, { message: 'Page not found' });
  }
  return {
    id: row.id,
    ownerId: row.owner_id ?? null,
    title: row.title,
    inheritancePolicy: row.inheritance_policy ?? 'inherit',
  };
};

sharesRoute.get('/with-me/tree', async (c) => {
  const user = c.get('user') as { id: string };
  const limitParam = c.req.query('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : null;
  if (parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new HTTPException(400, { message: 'limit must be a positive integer' });
  }

  const rootResult = await query(
    `
      with shared_items as (
        select
          s.id,
          s.entity_type,
          s.entity_id,
          s.permission,
          s.token,
          s.recipient_user_id,
          s.recipient_email,
          s.created_at,
          s.updated_at,
          owner.name as shared_by_name,
          owner.email as shared_by_email,
          recipient.name as recipient_name,
          recipient.avatar_url as recipient_avatar_url,
          case when s.entity_type = 'folder' then f.name else p.title end as entity_title,
          case when s.entity_type = 'folder' then f.icon else p.icon end as entity_icon,
          case
            when s.entity_type = 'folder' then get_root_folder_owner(f.id)
            else coalesce(get_root_folder_owner(p.parent_id), p.created_by)
          end as owner_id,
          case when s.entity_type = 'folder' then f.updated_at else p.updated_at end as entity_updated_at,
          greatest(
            coalesce(s.created_at, s.updated_at, to_timestamp(0)),
            coalesce(pv.visited_at, to_timestamp(0))
          ) as sort_at,
          'direct'::text as source
        from shares s
        left join pages p on p.id = s.entity_id and s.entity_type = 'page' and p.is_deleted = false
        left join folders f on f.id = s.entity_id and s.entity_type = 'folder' and f.is_deleted = false
        left join users owner on owner.id = s.shared_by
        left join users recipient on recipient.id = s.recipient_user_id
        left join page_visits pv on pv.page_id = p.id and pv.user_id = $1 and s.entity_type = 'page'
        where s.recipient_user_id = $1
          and s.token is null
          and (s.expires_at is null or s.expires_at > statement_timestamp())
          and ((s.entity_type = 'page' and p.id is not null) or (s.entity_type = 'folder' and f.id is not null))
          and case
            when s.entity_type = 'folder' then get_root_folder_owner(f.id) <> $1
            else coalesce(get_root_folder_owner(p.parent_id), p.created_by) <> $1
          end

        union all

        select
          pae.id,
          'page'::text as entity_type,
          pae.page_id as entity_id,
          access.permission,
          null::text as token,
          pae.user_id as recipient_user_id,
          null::text as recipient_email,
          pae.first_seen_at as created_at,
          pae.last_seen_at as updated_at,
          null::text as shared_by_name,
          null::text as shared_by_email,
          u.name as recipient_name,
          u.avatar_url as recipient_avatar_url,
          p.title as entity_title,
          p.icon as entity_icon,
          coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
          p.updated_at as entity_updated_at,
          pae.last_seen_at as sort_at,
          'link'::text as source
        from page_access_events pae
        join pages p on p.id = pae.page_id and p.is_deleted = false
        join shares active_link
          on active_link.entity_type = 'page'
         and active_link.entity_id = pae.page_id
         and active_link.token = pae.token
         and active_link.token is not null
         and (active_link.expires_at is null or active_link.expires_at > statement_timestamp())
        join users u on u.id = pae.user_id
        join lateral get_effective_page_permission(pae.page_id, $1) access on true
        where pae.user_id = $1
          and p.is_public = true
          and access.permission is not null
          and coalesce(get_root_folder_owner(p.parent_id), p.created_by) <> $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'page' and s.entity_id = pae.page_id
              and s.recipient_user_id = $1 and s.token is null
              and (s.expires_at is null or s.expires_at > statement_timestamp())
          )

        union all

        select
          fae.id,
          'folder'::text as entity_type,
          fae.folder_id as entity_id,
          access.permission,
          null::text as token,
          fae.user_id as recipient_user_id,
          null::text as recipient_email,
          fae.first_seen_at as created_at,
          fae.last_seen_at as updated_at,
          null::text as shared_by_name,
          null::text as shared_by_email,
          u.name as recipient_name,
          u.avatar_url as recipient_avatar_url,
          f.name as entity_title,
          f.icon as entity_icon,
          get_root_folder_owner(f.id) as owner_id,
          f.updated_at as entity_updated_at,
          fae.last_seen_at as sort_at,
          'link'::text as source
        from folder_access_events fae
        join folders f on f.id = fae.folder_id and f.is_deleted = false
        join shares active_link
          on active_link.entity_type = 'folder'
         and active_link.entity_id = fae.folder_id
         and active_link.token = fae.token
         and active_link.token is not null
         and (active_link.expires_at is null or active_link.expires_at > statement_timestamp())
        join users u on u.id = fae.user_id
        join lateral get_effective_folder_permission(fae.folder_id, $1) access on true
        where fae.user_id = $1
          and f.is_public = true
          and access.permission is not null
          and get_root_folder_owner(f.id) <> $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'folder' and s.entity_id = fae.folder_id
              and s.recipient_user_id = $1 and s.token is null
              and (s.expires_at is null or s.expires_at > statement_timestamp())
          )
      ),
      visible_shared_items as (
        select si.*
        from shared_items si
        where not exists (
          select 1
          from shared_items ancestor
          where ancestor.entity_type = 'folder'
            and (
              (
                si.entity_type = 'page'
                and exists (
                  select 1
                  from pages p
                  join folder_closure fc on fc.descendant_id = p.parent_id
                  where p.id = si.entity_id
                    and p.is_deleted = false
                    and fc.ancestor_id = ancestor.entity_id
                    and not is_page_folder_inheritance_blocked(ancestor.entity_id, p.id)
                )
              )
              or
              (
                si.entity_type = 'folder'
                and exists (
                  select 1
                  from folder_closure fc
                  where fc.ancestor_id = ancestor.entity_id
                    and fc.descendant_id = si.entity_id
                    and fc.depth > 0
                    and not is_folder_inheritance_blocked(ancestor.entity_id, si.entity_id)
                )
              )
            )
        )
      )
      select *
      from visible_shared_items
      order by sort_at desc nulls last, entity_updated_at desc nulls last
      ${parsedLimit === null ? '' : 'limit $2'}
    `,
    parsedLimit === null ? [user.id] : [user.id, parsedLimit],
  );

  const roots = rootResult.rows as SharedWithMeRow[];
  const rootFolderIds = roots
    .filter((row) => row.entity_type === 'folder')
    .map((row) => row.entity_id);
  const rootPageIds = roots.filter((row) => row.entity_type === 'page').map((row) => row.entity_id);

  const rootMetaByEntity = new Map(
    roots.map((row) => [`${row.entity_type}:${row.entity_id}`, row] as const),
  );

  const folderRows =
    rootFolderIds.length === 0
      ? []
      : ((
          await query(
            `
              with root_ids as (select unnest($2::uuid[]) as root_id)
              select
                root_ids.root_id,
                f.id,
                f.parent_id,
                f.name,
                f.icon,
                f.position,
                f.created_by,
                f.updated_at,
                get_root_folder_owner(f.id) as owner_id,
                access.permission as user_permission
              from root_ids
              join folder_closure fc on fc.ancestor_id = root_ids.root_id
              join folders f on f.id = fc.descendant_id and f.is_deleted = false
              join lateral get_effective_folder_permission(f.id, $1) access on true
              where access.permission is not null
                and not is_folder_inheritance_blocked(root_ids.root_id, f.id)
              order by root_ids.root_id, fc.depth asc, f.parent_id nulls first, f.position::numeric asc, f.updated_at desc nulls last
            `,
            [user.id, rootFolderIds],
          )
        ).rows as SharedNavigationFolderRow[]);

  const descendantPageRows =
    rootFolderIds.length === 0
      ? []
      : ((
          await query(
            `
              with root_ids as (select unnest($2::uuid[]) as root_id)
              select
                root_ids.root_id,
                p.id,
                p.parent_id,
                p.title,
                p.icon,
                p.position,
                p.created_by,
                p.updated_at,
                coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
                access.permission as user_permission
              from root_ids
              join folder_closure fc on fc.ancestor_id = root_ids.root_id
              join pages p on p.parent_id = fc.descendant_id and p.is_deleted = false
              join lateral get_effective_page_permission(p.id, $1) access on true
              where access.permission is not null
                and not is_page_folder_inheritance_blocked(root_ids.root_id, p.id)
              order by root_ids.root_id, fc.depth asc, p.parent_id nulls first, p.position::numeric asc, p.updated_at desc nulls last
            `,
            [user.id, rootFolderIds],
          )
        ).rows as SharedNavigationPageRow[]);

  const rootPageRows =
    rootPageIds.length === 0
      ? []
      : ((
          await query(
            `
              select
                null::uuid as root_id,
                p.id,
                p.parent_id,
                p.title,
                p.icon,
                p.position,
                p.created_by,
                p.updated_at,
                coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
                access.permission as user_permission
              from pages p
              join lateral get_effective_page_permission(p.id, $1) access on true
              where p.id = any($2::uuid[])
                and p.is_deleted = false
                and access.permission is not null
            `,
            [user.id, rootPageIds],
          )
        ).rows as SharedNavigationPageRow[]);

  const foldersByRootAndParent = new Map<string, Map<string, SharedNavigationFolderRow[]>>();
  for (const row of folderRows) {
    if (!row.parent_id || row.id === row.root_id) continue;
    const parentMap =
      foldersByRootAndParent.get(row.root_id) ?? new Map<string, SharedNavigationFolderRow[]>();
    const list = parentMap.get(row.parent_id) ?? [];
    list.push(row);
    parentMap.set(row.parent_id, list);
    foldersByRootAndParent.set(row.root_id, parentMap);
  }

  const pagesByRootAndParent = new Map<string, Map<string, SharedNavigationPageRow[]>>();
  for (const row of descendantPageRows) {
    if (!row.root_id || !row.parent_id) continue;
    const parentMap =
      pagesByRootAndParent.get(row.root_id) ?? new Map<string, SharedNavigationPageRow[]>();
    const list = parentMap.get(row.parent_id) ?? [];
    list.push(row);
    parentMap.set(row.parent_id, list);
    pagesByRootAndParent.set(row.root_id, parentMap);
  }

  const rootPageRowsById = new Map(rootPageRows.map((row) => [row.id, row]));
  const enumerableFolderIds = await getEnumerableFolderIds(user.id);

  const createPageNode = (
    row: SharedNavigationPageRow,
    rootMeta?: SharedWithMeRow,
  ): SharedNavigationPage => ({
    entityType: 'page',
    id: row.id,
    title: row.title ?? 'Untitled',
    icon: row.icon,
    parentId: redactParentId(row.parent_id, enumerableFolderIds),
    ownerId: row.owner_id,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    userPermission: row.user_permission,
    ...(rootMeta ? { source: rootMeta.source, sortAt: rootMeta.sort_at } : {}),
  });

  const createFolderNode = (
    rootId: string,
    row: SharedNavigationFolderRow,
  ): SharedNavigationFolder => {
    const rootMeta = rootMetaByEntity.get(`folder:${row.id}`);
    const childFolders = foldersByRootAndParent.get(rootId)?.get(row.id) ?? [];
    const childPages = pagesByRootAndParent.get(rootId)?.get(row.id) ?? [];
    return {
      entityType: 'folder',
      id: row.id,
      title: row.name ?? 'Untitled',
      icon: row.icon,
      parentId: redactParentId(row.parent_id, enumerableFolderIds),
      ownerId: row.owner_id,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      userPermission: row.user_permission,
      ...(rootMeta ? { source: rootMeta.source, sortAt: rootMeta.sort_at } : {}),
      children: [
        ...childFolders.map((folder) => createFolderNode(rootId, folder)),
        ...childPages.map((page) => createPageNode(page)),
      ],
    };
  };

  const folderRowByRootId = new Map(
    folderRows.filter((row) => row.id === row.root_id).map((row) => [row.root_id, row]),
  );

  const items: SharedNavigationItem[] = roots
    .map((root): SharedNavigationItem | null => {
      if (root.entity_type === 'folder') {
        const folder = folderRowByRootId.get(root.entity_id);
        return folder ? createFolderNode(root.entity_id, folder) : null;
      }
      const page = rootPageRowsById.get(root.entity_id);
      return page ? createPageNode(page, root) : null;
    })
    .filter((item): item is SharedNavigationItem => item !== null);

  return c.json(items);
});

sharesRoute.get('/with-me', async (c) => {
  const user = c.get('user') as { id: string };
  const limitParam = c.req.query('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : null;
  if (parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new HTTPException(400, { message: 'limit must be a positive integer' });
  }

  const result = await query(
    `
      with shared_items as (
        select
          s.id,
          s.entity_type,
          s.entity_id,
          s.permission,
          s.token,
          s.recipient_user_id,
          s.recipient_email,
          s.created_at,
          s.updated_at,
          owner.name as shared_by_name,
          owner.email as shared_by_email,
          recipient.name as recipient_name,
          recipient.avatar_url as recipient_avatar_url,
          case when s.entity_type = 'folder' then f.name else p.title end as entity_title,
          case when s.entity_type = 'folder' then f.icon else p.icon end as entity_icon,
          case
            when s.entity_type = 'folder' then get_root_folder_owner(f.id)
            else coalesce(get_root_folder_owner(p.parent_id), p.created_by)
          end as owner_id,
          case when s.entity_type = 'folder' then f.updated_at else p.updated_at end as entity_updated_at,
          greatest(
            coalesce(s.created_at, s.updated_at, to_timestamp(0)),
            coalesce(pv.visited_at, to_timestamp(0))
          ) as sort_at,
          'direct'::text as source
        from shares s
        left join pages p on p.id = s.entity_id and s.entity_type = 'page' and p.is_deleted = false
        left join folders f on f.id = s.entity_id and s.entity_type = 'folder' and f.is_deleted = false
        left join users owner on owner.id = s.shared_by
        left join users recipient on recipient.id = s.recipient_user_id
        left join page_visits pv on pv.page_id = p.id and pv.user_id = $1 and s.entity_type = 'page'
        where s.recipient_user_id = $1
          and s.token is null
          and (s.expires_at is null or s.expires_at > statement_timestamp())
          and ((s.entity_type = 'page' and p.id is not null) or (s.entity_type = 'folder' and f.id is not null))
          and case
            when s.entity_type = 'folder' then get_root_folder_owner(f.id) <> $1
            else coalesce(get_root_folder_owner(p.parent_id), p.created_by) <> $1
          end

        union all

        select
          pae.id,
          'page'::text as entity_type,
          pae.page_id as entity_id,
          access.permission,
          null::text as token,
          pae.user_id as recipient_user_id,
          null::text as recipient_email,
          pae.first_seen_at as created_at,
          pae.last_seen_at as updated_at,
          null::text as shared_by_name,
          null::text as shared_by_email,
          u.name as recipient_name,
          u.avatar_url as recipient_avatar_url,
          p.title as entity_title,
          p.icon as entity_icon,
          coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id,
          p.updated_at as entity_updated_at,
          pae.last_seen_at as sort_at,
          'link'::text as source
        from page_access_events pae
        join pages p on p.id = pae.page_id and p.is_deleted = false
        join shares active_link
          on active_link.entity_type = 'page'
         and active_link.entity_id = pae.page_id
         and active_link.token = pae.token
         and active_link.token is not null
         and (active_link.expires_at is null or active_link.expires_at > statement_timestamp())
        join users u on u.id = pae.user_id
        join lateral get_effective_page_permission(pae.page_id, $1) access on true
        where pae.user_id = $1
          and p.is_public = true
          and access.permission is not null
          and coalesce(get_root_folder_owner(p.parent_id), p.created_by) <> $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'page' and s.entity_id = pae.page_id
              and s.recipient_user_id = $1 and s.token is null
              and (s.expires_at is null or s.expires_at > statement_timestamp())
          )

        union all

        select
          fae.id,
          'folder'::text as entity_type,
          fae.folder_id as entity_id,
          access.permission,
          null::text as token,
          fae.user_id as recipient_user_id,
          null::text as recipient_email,
          fae.first_seen_at as created_at,
          fae.last_seen_at as updated_at,
          null::text as shared_by_name,
          null::text as shared_by_email,
          u.name as recipient_name,
          u.avatar_url as recipient_avatar_url,
          f.name as entity_title,
          f.icon as entity_icon,
          get_root_folder_owner(f.id) as owner_id,
          f.updated_at as entity_updated_at,
          fae.last_seen_at as sort_at,
          'link'::text as source
        from folder_access_events fae
        join folders f on f.id = fae.folder_id and f.is_deleted = false
        join shares active_link
          on active_link.entity_type = 'folder'
         and active_link.entity_id = fae.folder_id
         and active_link.token = fae.token
         and active_link.token is not null
         and (active_link.expires_at is null or active_link.expires_at > statement_timestamp())
        join users u on u.id = fae.user_id
        join lateral get_effective_folder_permission(fae.folder_id, $1) access on true
        where fae.user_id = $1
          and f.is_public = true
          and access.permission is not null
          and get_root_folder_owner(f.id) <> $1
          and not exists (
            select 1 from shares s
            where s.entity_type = 'folder' and s.entity_id = fae.folder_id
              and s.recipient_user_id = $1 and s.token is null
              and (s.expires_at is null or s.expires_at > statement_timestamp())
          )
      ),
      visible_shared_items as (
        select si.*
        from shared_items si
        where not exists (
          select 1
          from shared_items ancestor
          where ancestor.entity_type = 'folder'
            and (
              (
                si.entity_type = 'page'
                and exists (
                  select 1
                  from pages p
                  join folder_closure fc on fc.descendant_id = p.parent_id
                  where p.id = si.entity_id
                    and p.is_deleted = false
                    and fc.ancestor_id = ancestor.entity_id
                    and not is_page_folder_inheritance_blocked(ancestor.entity_id, p.id)
                )
              )
              or
              (
                si.entity_type = 'folder'
                and exists (
                  select 1
                  from folder_closure fc
                  where fc.ancestor_id = ancestor.entity_id
                    and fc.descendant_id = si.entity_id
                    and fc.depth > 0
                    and not is_folder_inheritance_blocked(ancestor.entity_id, si.entity_id)
                )
              )
            )
        )
      )
      select *
      from visible_shared_items
      order by sort_at desc nulls last, entity_updated_at desc nulls last
      ${parsedLimit === null ? '' : 'limit $2'}
    `,
    parsedLimit === null ? [user.id] : [user.id, parsedLimit],
  );

  return c.json(
    result.rows.map((row) => {
      const item = row as ShareRow & {
        entity_title: string | null;
        entity_icon: string | null;
        owner_id: string | null;
        entity_updated_at: Date | null;
        sort_at: Date | null;
        source: 'direct' | 'link';
      };
      return {
        ...normalizeShare(item),
        title: item.entity_title ?? 'Untitled',
        icon: item.entity_icon,
        ownerId: item.owner_id,
        entityUpdatedAt: item.entity_updated_at,
        sortAt: item.sort_at,
        source: item.source,
      };
    }),
  );
});

sharesRoute.get('/pages/collaborators', async (c) => {
  const pageIdsParam = c.req.query('pageIds');
  if (!pageIdsParam) {
    return c.json({ error: 'pageIds query parameter is required' }, 400);
  }

  const pageIds = pageIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (pageIds.length === 0) {
    return c.json({});
  }

  const user = c.get('user') as { id: string };
  const limitedPageIds = pageIds.slice(0, 50);

  // Verify caller has access to each page before returning its collaborators
  const results = await Promise.all(
    limitedPageIds.map(async (id) => {
      try {
        return await db.transaction(async (tx) => {
          await lockEntityAccess(tx, 'page', id);
          const access = await ensurePageAccess(id, user.id, 'view', tx);
          const accessors = await getPageAccessors(id, tx);
          if (!access.fullAccess && access.permission !== 'admin') {
            return toCollaboratorPresence(accessors, user.id);
          }
          return redactAccessorFolderSources(accessors, await getEnumerableFolderIds(user.id, tx));
        });
      } catch (error) {
        if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) {
          return [];
        }
        throw error;
      }
    }),
  );
  const collaborators = Object.fromEntries(limitedPageIds.map((id, i) => [id, results[i]]));

  return c.json(collaborators);
});

sharesRoute.get('/folders/collaborators', async (c) => {
  const folderIdsParam = c.req.query('folderIds');
  if (!folderIdsParam) {
    return c.json({ error: 'folderIds query parameter is required' }, 400);
  }

  const folderIds = folderIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (folderIds.length === 0) {
    return c.json({});
  }

  const user = c.get('user') as { id: string };
  const limitedFolderIds = folderIds.slice(0, 50);

  // Verify caller has access to each folder before returning its collaborators
  const results = await Promise.all(
    limitedFolderIds.map(async (id) => {
      try {
        return await db.transaction(async (tx) => {
          await lockEntityAccess(tx, 'folder', id);
          const access = await ensureFolderAccess(id, user.id, 'view', tx);
          const accessors = await getFolderAccessors(id, tx);
          if (!access.fullAccess && access.permission !== 'admin') {
            return toCollaboratorPresence(accessors, user.id);
          }
          return redactAccessorFolderSources(accessors, await getEnumerableFolderIds(user.id, tx));
        });
      } catch (error) {
        if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) {
          return [];
        }
        throw error;
      }
    }),
  );
  const collaborators = Object.fromEntries(limitedFolderIds.map((id, i) => [id, results[i]]));

  return c.json(collaborators);
});

sharesRoute.get('/entity/:entityType/:entityId', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  return db.transaction(async (tx) => {
    await lockEntityAccess(tx, entityType, entityId);
    const entity = await resolveEntity(entityType, entityId, tx);
    // Determine the caller's effective permission — ensures access and captures
    // the highest permission across invites, folder inheritance, and link shares.
    let userPermission: SharePermission | null = null;
    let hasManagementAccess = false;
    if (entityType === 'page') {
      const access = await ensurePageAccess(entity.id, user.id, 'view', tx);
      userPermission = access.permission;
      hasManagementAccess = access.fullAccess || access.permission === 'admin';
    } else {
      const access = await ensureFolderAccess(entity.id, user.id, 'view', tx);
      userPermission = access.permission;
      hasManagementAccess = access.fullAccess || access.permission === 'admin';
    }

    // Sharing identities, invite rows, link tokens, and inheritance topology are
    // management data. Ordinary viewers/editors only need their effective
    // capabilities plus aggregate collaborator presence to render the entity.
    if (!hasManagementAccess) {
      const accessors =
        entityType === 'page'
          ? await getPageAccessors(entityId, tx)
          : await getFolderAccessors(entityId, tx);
      return c.json({
        visibility: 'limited',
        collaboratorCount: accessors.filter((accessor) => accessor.userId !== user.id).length,
        entity: {
          type: entityType,
          id: entity.id,
          title: entity.title,
          ownerId: null,
        },
        link: { permission: 'private', token: null, url: null },
        inheritance: { policy: 'inherit' },
        invites: [],
        accessors: [],
        accessSources: [],
        inheritedLinks: [],
        userPermission,
        capabilities: deriveCapabilities(userPermission),
        permissionDetails: [],
        inheritedAccessors: [],
      });
    }

    const result = await executeQuery(
      tx,
      `
      select
        s.id,
        s.entity_type,
        s.entity_id,
        s.permission,
        s.token,
        s.recipient_user_id,
        s.recipient_email,
        s.created_at,
        s.updated_at,
        owner.name as shared_by_name,
        owner.email as shared_by_email,
        recipient.name as recipient_name,
        recipient.avatar_url as recipient_avatar_url
      from shares s
      left join users owner on owner.id = s.shared_by
      left join users recipient on recipient.id = s.recipient_user_id
      where s.entity_type = $1 and s.entity_id = $2
        and (s.expires_at is null or s.expires_at > statement_timestamp())
      order by s.token nulls last, s.created_at asc
    `,
      [entityType, entityId],
    );

    const shares = (result.rows as ShareRow[]).map(normalizeShare);
    const linkShare = shares.find(
      (share): share is typeof share & { token: string } => share.token !== null,
    );
    const [accessors, accessSources, inheritedLinks] = await Promise.all([
      entityType === 'page' ? getPageAccessors(entityId, tx) : getFolderAccessors(entityId, tx),
      entityType === 'page'
        ? getPageAccessSources(entityId, tx)
        : getFolderAccessSources(entityId, tx),
      getInheritedPublicLinks(entityType, entityId, tx),
    ]);
    const enumerableFolderIds = await getEnumerableFolderIds(user.id, tx);

    const permissionDetails: Array<{
      source: string;
      permission: string;
      grantedByName?: string | null;
      grantedByEmail?: string | null;
      folderName?: string | null;
      folderId?: string | null;
    }> = [];
    if (entityType === 'page') {
      // Fetch each permission source separately to avoid parameter type inference issues
      const inviteRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT permission FROM shares
       WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2
         AND token IS NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
        [entityId, user.id],
      );
      inviteRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'invite', permission: row.permission });
      });

      const folderRows = await executeQuery<{
        permission: string;
        granted_by_name: string | null;
        granted_by_email: string | null;
        folder_name: string | null;
        folder_id: string | null;
      }>(
        tx,
        `WITH page_parent AS (SELECT parent_id FROM pages WHERE id = $1)
       SELECT s.permission, u.name AS granted_by_name, u.email AS granted_by_email,
              f.name AS folder_name, f.id::text AS folder_id
       FROM shares s
       JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
       JOIN folders f ON f.id = fc.ancestor_id
       JOIN page_parent pp ON fc.descendant_id = pp.parent_id
        LEFT JOIN users u ON u.id = s.shared_by
        WHERE s.entity_type = 'folder' AND s.recipient_user_id = $2
          AND (s.expires_at IS NULL OR s.expires_at > statement_timestamp())
          AND NOT is_page_folder_inheritance_blocked(s.entity_id, $1)`,
        [entityId, user.id],
      );
      folderRows.rows.forEach((row) => {
        permissionDetails.push({
          source: 'folder',
          permission: row.permission,
          grantedByName: row.granted_by_name ?? null,
          grantedByEmail: row.granted_by_email ?? null,
          folderName: row.folder_name ?? null,
          folderId: row.folder_id ?? null,
        });
      });

      const linkRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT permission FROM shares
       WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())
         AND EXISTS (SELECT 1 FROM pages WHERE id = $1 AND is_public = true)`,
        [entityId],
      );
      linkRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'link', permission: row.permission });
      });

      const workspaceRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END AS permission
       FROM workspace_members wm
       WHERE wm.workspace_owner_id = (
         SELECT COALESCE(get_root_folder_owner(p2.parent_id), p2.created_by)
         FROM pages p2
         WHERE p2.id = $1
        ) AND wm.member_id = $2
        AND NOT is_page_path_restricted($1)`,
        [entityId, user.id],
      );
      workspaceRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'workspace', permission: row.permission });
      });
    }

    if (entityType === 'folder') {
      const inviteRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT permission FROM shares
       WHERE entity_type = 'folder' AND entity_id = $1 AND recipient_user_id = $2
         AND token IS NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
        [entityId, user.id],
      );
      inviteRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'invite', permission: row.permission });
      });

      const linkRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT permission FROM shares
       WHERE entity_type = 'folder' AND entity_id = $1 AND token IS NOT NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())
         AND EXISTS (SELECT 1 FROM folders WHERE id = $1 AND is_public = true AND is_deleted = false)`,
        [entityId],
      );
      linkRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'link', permission: row.permission });
      });

      const workspaceRows = await executeQuery<{ permission: string }>(
        tx,
        `SELECT CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END AS permission
       FROM workspace_members wm
        WHERE wm.workspace_owner_id = get_root_folder_owner($1) AND wm.member_id = $2
        AND NOT is_folder_path_restricted($1)`,
        [entityId, user.id],
      );
      workspaceRows.rows.forEach((row: { permission: string }) => {
        permissionDetails.push({ source: 'workspace', permission: row.permission });
      });
    }

    const inheritedAccessors: Array<{
      userId: string;
      name: string | null;
      email: string | null;
      permission: string;
      source: string;
      folderName?: string | null;
      folderId?: string | null;
    }> = [];
    if (accessors.length > 0) {
      const existingUserIds = new Set(accessors.map((a) => a.userId));
      const ownerResult =
        entityType === 'page'
          ? await executeQuery(
              tx,
              `SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by) as owner_id
             FROM pages p
             WHERE p.id = $1`,
              [entityId],
            )
          : await executeQuery(
              tx,
              'SELECT get_root_folder_owner(id) as owner_id FROM folders WHERE id = $1',
              [entityId],
            );
      const ownerId = ownerResult.rows[0]?.owner_id as string | undefined;

      const inheritedResult = await executeQuery(
        tx,
        `SELECT wm.member_id, u.name, u.email,
               CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END AS permission
        FROM workspace_members wm
       JOIN users u ON u.id = wm.member_id
       WHERE wm.workspace_owner_id = $1
         AND (
           ($2 = 'page' AND NOT is_page_path_restricted($3))
           OR ($2 = 'folder' AND NOT is_folder_path_restricted($3))
         )`,
        [ownerId, entityType, entityId],
      );
      for (const row of inheritedResult.rows) {
        if (!existingUserIds.has(row.member_id)) {
          inheritedAccessors.push({
            userId: row.member_id,
            name: row.name,
            email: row.email,
            permission: row.permission,
            source: 'workspace',
          });
        }
      }
    }

    const redactedAccessSources = accessSources.map((source) => {
      if (!source.folderId || enumerableFolderIds.has(source.folderId)) return source;
      const redacted = { ...source, shareId: null };
      delete redacted.folderId;
      delete redacted.folderName;
      return redacted;
    });
    const redactedInheritedLinks = inheritedLinks.filter((link) =>
      enumerableFolderIds.has(link.entityId),
    );
    const redactedAccessors = redactAccessorFolderSources(accessors, enumerableFolderIds);
    const redactedPermissionDetails = permissionDetails.map((detail) => {
      if (!detail.folderId || enumerableFolderIds.has(detail.folderId)) return detail;
      const redacted = { ...detail };
      delete redacted.folderId;
      delete redacted.folderName;
      return redacted;
    });

    return c.json({
      visibility: 'full',
      collaboratorCount: accessors.filter((accessor) => accessor.userId !== user.id).length,
      entity: {
        type: entityType,
        id: entity.id,
        title: entity.title,
        ownerId: entity.ownerId ?? null,
      },
      link: linkShare
        ? {
            permission: linkShare.permission,
            token: linkShare.token,
            url:
              entityType === 'page'
                ? appendShareToken(buildPagePath(entity.title, entity.id), linkShare.token)
                : appendShareToken(buildFolderPath(entity.title, entity.id), linkShare.token),
          }
        : { permission: 'private', token: null, url: null },
      inheritance: {
        policy: entity.inheritancePolicy,
      },
      invites: shares.filter((share) => !share.token),
      accessors: redactedAccessors,
      accessSources: redactedAccessSources,
      inheritedLinks: redactedInheritedLinks,
      userPermission,
      capabilities: deriveCapabilities(userPermission, entity.ownerId === user.id),
      permissionDetails: redactedPermissionDetails,
      inheritedAccessors,
    });
  });
});

sharesRoute.patch('/entity/:entityType/:entityId/inheritance', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }

  const policy = (body as { policy?: unknown }).policy;
  if (policy !== 'inherit' && policy !== 'restricted') {
    throw new HTTPException(400, { message: 'Invalid inheritance policy' });
  }

  await ensureCanAdminEntity(entityType, entity.id, user.id);

  const policyMessage =
    policy === 'restricted'
      ? `${entity.title} stopped inheriting access`
      : `${entity.title} now inherits access`;
  await db.transaction(async (tx) => {
    await lockShareMutation(tx, entityType, entityId);
    await ensureCanAdminEntity(entityType, entityId, user.id, tx);
    const affectedBefore = await getEntityMetaUserIds(tx, entityType, entityId);
    await executeQuery(
      tx,
      entityType === 'page'
        ? 'update pages set inheritance_policy = $1, updated_at = now() where id = $2'
        : 'update folders set inheritance_policy = $1, updated_at = now() where id = $2',
      [policy, entityId],
    );
    const affectedAfter = await getEntityMetaUserIds(tx, entityType, entityId);
    await notifyShareRecompute(
      {
        entityType,
        entityId,
        metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
        message: policyMessage,
      },
      tx,
    );
  });

  return c.json({
    policy,
    message:
      policy === 'restricted'
        ? `${entity.title} stopped inheriting access`
        : `${entity.title} now inherits access`,
  });
});

sharesRoute.patch('/entity/:entityType/:entityId/link', async (c) => {
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const permission = (body as { permission?: unknown }).permission;

  await ensureCanAdminEntity(entityType, entity.id, user.id);

  if (permission === 'private') {
    await db.transaction(async (tx) => {
      await lockShareMutation(tx, entityType, entityId);
      await ensureCanAdminEntity(entityType, entityId, user.id, tx);
      // Capture link visitors before removing their provenance rows so every
      // dashboard-only client receives the revocation invalidation.
      const affectedBefore = await getEntityMetaUserIds(tx, entityType, entityId);
      await executeQuery(
        tx,
        'delete from shares where entity_type = $1 and entity_id = $2 and token is not null',
        [entityType, entityId],
      );
      if (entityType === 'page') {
        await executeQuery(
          tx,
          'update pages set is_public = false, public_token = null, updated_at = now() where id = $1',
          [entityId],
        );
        await executeQuery(
          tx,
          "delete from page_access_events where page_id = $1 and source = 'link'",
          [entityId],
        );
      } else if (entityType === 'folder') {
        await executeQuery(
          tx,
          'update folders set is_public = false, public_token = null where id = $1',
          [entityId],
        );
        await executeQuery(
          tx,
          "delete from folder_access_events where folder_id = $1 and source = 'link'",
          [entityId],
        );
      }
      const affectedAfter = await getEntityMetaUserIds(tx, entityType, entityId);
      await notifyShareRevoke(
        {
          entityType,
          entityId,
          metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
          message: `Link access removed for ${entity.title}`,
        },
        tx,
      );
    });
    return c.json({
      permission: 'private',
      token: null,
      url: null,
      message: `Link access removed for ${entity.title}`,
    });
  }

  const nextPermission = parseLinkPermission(permission);
  const linkMessage =
    nextPermission === 'view'
      ? `${entity.title} is now view only with link`
      : `${entity.title} is now editable with link`;
  let token = '';
  await db.transaction(async (tx) => {
    await lockShareMutation(tx, entityType, entityId);
    await ensureCanAdminEntity(entityType, entityId, user.id, tx);
    const affectedBefore = await getEntityMetaUserIds(tx, entityType, entityId);
    const linkResult = await executeQuery<{ token: string }>(
      tx,
      `insert into shares (entity_type, entity_id, shared_by, permission, token)
       values ($1, $2, $3, $4, $5)
       on conflict (entity_type, entity_id) where token is not null
       do update set permission = excluded.permission, expires_at = null, updated_at = now()
       returning token`,
      [entityType, entityId, user.id, nextPermission, crypto.randomUUID()],
    );
    const storedToken = linkResult.rows[0]?.token;
    if (!storedToken) {
      throw new Error('Link share upsert did not return a token');
    }
    token = storedToken;

    if (entityType === 'page') {
      await executeQuery(
        tx,
        'update pages set is_public = true, public_token = $1, updated_at = now() where id = $2',
        [token, entityId],
      );
      await executeQuery(
        tx,
        'update page_access_events set permission = $1 where page_id = $2 and source = $3',
        [nextPermission, entityId, 'link'],
      );
    } else if (entityType === 'folder') {
      await executeQuery(
        tx,
        'update folders set is_public = true, public_token = $1 where id = $2',
        [token, entityId],
      );
      await executeQuery(
        tx,
        'update folder_access_events set permission = $1 where folder_id = $2 and source = $3',
        [nextPermission, entityId, 'link'],
      );
    }
    const affectedAfter = await getEntityMetaUserIds(tx, entityType, entityId);
    await notifyShareUpdate(
      {
        entityType,
        entityId,
        permission: nextPermission,
        metaUserIds: mergeMetaUserIds(affectedBefore, affectedAfter),
        message: linkMessage,
      },
      tx,
    );
  });

  return c.json({
    permission: nextPermission,
    token,
    url:
      entityType === 'page'
        ? appendShareToken(buildPagePath(entity.title, entity.id), token)
        : appendShareToken(buildFolderPath(entity.title, entity.id), token),
    message: linkMessage,
  });
});

sharesRoute.post('/entity/:entityType/:entityId/invite', async (c) => {
  const requestTimestamp = Date.now();
  const entityType = parseEntityType(c.req.param('entityType'));
  const entityId = c.req.param('entityId');
  const user = c.get('user') as { id: string };
  const entity = await resolveEntity(entityType, entityId);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const { email, permission, expiresAt } = body as {
    email?: unknown;
    permission?: unknown;
    expiresAt?: unknown;
  };
  if (typeof email !== 'string' || email.trim().length === 0) {
    throw new HTTPException(400, { message: 'Email is required' });
  }

  await ensureCanAdminEntity(entityType, entity.id, user.id);

  const userResult = await query(
    'select id, email from users where lower(email) = lower($1) limit 1',
    [email.trim()],
  );
  const recipient = userResult.rows[0] as { id: string; email: string } | undefined;
  if (!recipient) {
    throw new HTTPException(404, { message: 'User not found' });
  }
  if (recipient.id === user.id) {
    throw new HTTPException(400, { message: 'Cannot share with yourself' });
  }

  if (entity.ownerId && recipient.id === entity.ownerId) {
    throw new HTTPException(400, { message: 'Owner already has full access' });
  }

  const nextPermission = parsePermission(permission);
  const nextExpiresAt = parseShareExpiration(expiresAt, requestTimestamp);

  const sharerResult = await query('select name from users where id = $1 limit 1', [user.id]);
  const sharedByName =
    (sharerResult.rows[0] as { name: string | null } | undefined)?.name ?? 'Someone';

  let isNewInvite = false;
  let inviteMessage = '';

  await db.transaction(async (tx) => {
    await lockShareMutation(tx, entityType, entityId);
    const actorAccess = await ensureCanAdminEntity(entityType, entityId, user.id, tx);
    if (nextPermission === 'admin' && !actorAccess.fullAccess) {
      throw new HTTPException(403, { message: 'Only the owner can grant admin access' });
    }
    const existing = await executeQuery(
      tx,
      `select id, permission,
              (expires_at is null or expires_at > statement_timestamp()) as is_active
       from shares
       where entity_type = $1
         and entity_id = $2
         and recipient_user_id = $3
         and token is null
       limit 1
      for update`,
      [entityType, entityId, recipient.id],
    );
    const existingRow = existing.rows[0] as
      | { id: string; permission: SharePermission; is_active: boolean }
      | undefined;
    if (existingRow?.permission === 'admin' && !actorAccess.fullAccess) {
      throw new HTTPException(403, { message: 'Only the owner can change an admin' });
    }

    if (nextExpiresAt !== null) {
      const expirationCheck = await executeQuery<{ is_future: boolean }>(
        tx,
        'select $1::timestamptz > clock_timestamp() as is_future',
        [nextExpiresAt],
      );
      if (expirationCheck.rows[0]?.is_future !== true) {
        throw new HTTPException(400, {
          message: 'Expiration must be in the future',
          cause: { code: 'EXPIRATION_NOT_FUTURE' },
        });
      }
    }

    if (existingRow) {
      // A dormant row is only a storage detail. Reactivating it is a fresh
      // effective grant and must notify the recipient like a new invitation.
      isNewInvite = !existingRow.is_active;
      await executeQuery(
        tx,
        'update shares set permission = $1, expires_at = $2, updated_at = now() where id = $3',
        [nextPermission, nextExpiresAt, existingRow.id],
      );
    } else {
      isNewInvite = true;
      await executeQuery(
        tx,
        `
          insert into shares (
            entity_type,
            entity_id,
            shared_by,
            recipient_user_id,
            recipient_email,
            permission,
            expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          entityType,
          entityId,
          user.id,
          recipient.id,
          recipient.email,
          nextPermission,
          nextExpiresAt,
        ],
      );
    }
    inviteMessage = isNewInvite
      ? `Invited ${recipient.email} as ${nextPermission} to ${entity.title}`
      : `Updated ${recipient.email}'s access to ${nextPermission} on ${entity.title}`;
    const notification = {
      entityType,
      entityId,
      permission: nextPermission,
      targetUserId: recipient.id,
      entityTitle: entity.title,
      sharedByName,
      message: inviteMessage,
    };
    if (isNewInvite) {
      await notifyShareGrant(notification, tx);
    } else {
      // An existing grant is a permission transition, not a new invitation.
      // Keeping it off the invite queue prevents stale invite toasts from
      // racing a later update or revoke.
      await notifyShareUpdate(notification, tx);
    }
  });

  if (isNewInvite) {
    const entityUrl =
      entityType === 'page'
        ? `${process.env.FRONTEND_URL ?? ''}${buildPagePath(entity.title, entity.id)}`
        : `${process.env.FRONTEND_URL ?? ''}${buildFolderPath(entity.title, entity.id)}`;

    try {
      const delivery = await sendShareInviteEmail({
        to: recipient.email,
        entityTitle: entity.title,
        entityType,
        sharedByName,
        permission: nextPermission,
        entityUrl,
      });
      if (delivery === 'disabled') {
        getApiLogger().warn('Share invitation email skipped because SMTP is not configured', {
          entityType,
          entityId,
          recipientUserId: recipient.id,
        });
      }
    } catch (error) {
      getApiLogger().error('Share invitation email delivery failed', {
        error: error instanceof Error ? error.message : String(error),
        entityType,
        entityId,
        recipientUserId: recipient.id,
      });
    }
  }

  return c.json({ ok: true, message: inviteMessage });
});

sharesRoute.patch('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user') as { id: string };

  const result = await query(
    'select entity_type, entity_id, token from shares where id = $1 limit 1',
    [shareId],
  );
  const row = result.rows[0] as
    | {
        entity_type?: ShareEntityType;
        entity_id?: string;
        token?: string | null;
      }
    | undefined;
  if (!row?.entity_type || !row.entity_id) {
    throw new HTTPException(404, { message: 'Share not found' });
  }
  if (row.token) {
    throw new HTTPException(400, {
      message: 'Public links must be managed through link settings',
    });
  }
  const shareEntityType = row.entity_type;
  const shareEntityId = row.entity_id;

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid body' });
  }
  const permission = (body as { permission?: unknown }).permission;
  const nextPermission = parsePermission(permission);

  await ensureCanAdminEntity(row.entity_type, row.entity_id, user.id);

  const entity = await resolveEntity(row.entity_type, row.entity_id);
  const updateMessage = `Updated ${entity.title} to ${nextPermission}`;

  await db.transaction(async (tx) => {
    await lockShareMutation(tx, shareEntityType, shareEntityId);
    const actorAccess = await ensureCanAdminEntity(shareEntityType, shareEntityId, user.id, tx);
    const targetResult = await executeQuery(
      tx,
      `select permission, recipient_user_id, token
       from shares
       where id = $1
       limit 1
       for update`,
      [shareId],
    );
    const targetRow = targetResult.rows[0] as
      | { permission: SharePermission; recipient_user_id: string | null; token: string | null }
      | undefined;
    if (!targetRow) {
      throw new HTTPException(404, { message: 'Share not found' });
    }
    if (targetRow.token) {
      throw new HTTPException(400, {
        message: 'Public links must be managed through link settings',
      });
    }
    if (
      (targetRow.permission === 'admin' || nextPermission === 'admin') &&
      !actorAccess.fullAccess
    ) {
      throw new HTTPException(403, {
        message: 'Only the owner can grant or change admin access',
      });
    }

    await executeQuery(tx, 'update shares set permission = $1, updated_at = now() where id = $2', [
      nextPermission,
      shareId,
    ]);
    await notifyShareUpdate(
      {
        entityType: shareEntityType,
        entityId: shareEntityId,
        permission: nextPermission,
        ...(targetRow.recipient_user_id ? { targetUserId: targetRow.recipient_user_id } : {}),
        message: updateMessage,
      },
      tx,
    );
  });

  return c.json({ ok: true, message: updateMessage });
});

sharesRoute.delete('/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const user = c.get('user') as { id: string };
  const result = await query(
    'select entity_type, entity_id, recipient_user_id, token from shares where id = $1 limit 1',
    [shareId],
  );
  const row = result.rows[0] as
    | {
        entity_type?: ShareEntityType;
        entity_id?: string;
        recipient_user_id?: string | null;
        token?: string | null;
      }
    | undefined;
  if (!row?.entity_type || !row.entity_id) {
    throw new HTTPException(404, { message: 'Share not found' });
  }
  if (row.token) {
    throw new HTTPException(400, {
      message: 'Public links must be managed through link settings',
    });
  }
  const shareEntityType = row.entity_type;
  const shareEntityId = row.entity_id;

  const isSelfRemoval = row.recipient_user_id === user.id;

  if (!isSelfRemoval) {
    await ensureCanAdminEntity(row.entity_type, row.entity_id, user.id);
  }

  const entity = await resolveEntity(row.entity_type, row.entity_id);
  const revokeMessage = isSelfRemoval ? `Left ${entity.title}` : `Removed from ${entity.title}`;

  await db.transaction(async (tx) => {
    await lockShareMutation(tx, shareEntityType, shareEntityId);
    const actorAccess = isSelfRemoval
      ? null
      : await ensureCanAdminEntity(shareEntityType, shareEntityId, user.id, tx);
    const targetResult = await executeQuery(
      tx,
      `select permission, recipient_user_id, token
       from shares
       where id = $1
       limit 1
       for update`,
      [shareId],
    );
    const targetRow = targetResult.rows[0] as
      | { permission: SharePermission; recipient_user_id: string | null; token: string | null }
      | undefined;
    if (!targetRow) {
      throw new HTTPException(404, { message: 'Share not found' });
    }
    if (targetRow.token) {
      throw new HTTPException(400, {
        message: 'Public links must be managed through link settings',
      });
    }
    if (!isSelfRemoval && targetRow.permission === 'admin' && !actorAccess?.fullAccess) {
      throw new HTTPException(403, { message: 'Only the owner can remove an admin' });
    }

    await executeQuery(tx, 'delete from shares where id = $1', [shareId]);

    await notifyShareRevoke(
      {
        entityType: shareEntityType,
        entityId: shareEntityId,
        ...(targetRow.recipient_user_id ? { targetUserId: targetRow.recipient_user_id } : {}),
        ...(isSelfRemoval && entity.ownerId ? { metaUserIds: [entity.ownerId] } : {}),
        message: revokeMessage,
      },
      tx,
    );
  });

  return c.json({ ok: true, message: revokeMessage });
});

export default sharesRoute;
