import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Custom bytea type for binary data
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

const tsvector = customType<{ data: string; notNull: false; default: false }>({
  dataType() {
    return 'tsvector';
  },
});

// ======================
// Better Auth Tables
// ======================

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').default(sql`gen_random_uuid()::text`).primaryKey(),
    expiresAt: timestamp('expires_at'),
    token: text('token').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    tokenIdx: index('sessions_token_idx').on(table.token),
  }),
);

export const accounts = pgTable('accounts', {
  id: text('id').default(sql`gen_random_uuid()::text`).primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const verifications = pgTable('verifications', {
  id: text('id').default(sql`gen_random_uuid()::text`).primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at').notNull(),
});

// ======================
// App Tables
// ======================

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    emailVerified: boolean('email_verified').default(false),
    image: text('image'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    systemRole: text('system_role').$type<'super_admin'>(),
  },
  (table) => ({
    systemRoleCheck: check(
      'users_system_role_check',
      sql`${table.systemRole} is null or ${table.systemRole} = 'super_admin'`,
    ),
  }),
);

export const workspaceAccessVersions = pgTable('workspace_access_versions', {
  workspaceOwnerId: uuid('workspace_owner_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'bigint' }).notNull().default(0n),
});

export const shares = pgTable(
  'shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entityType: text('entity_type').notNull().$type<'folder' | 'page'>(),
    entityId: uuid('entity_id').notNull(),
    sharedBy: uuid('shared_by').references(() => users.id, { onDelete: 'set null' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull().default('view').$type<'view' | 'edit' | 'admin'>(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    entityIdx: index('shares_entity_idx').on(table.entityType, table.entityId),
    recipientIdx: index('shares_recipient_idx').on(table.recipientUserId),
    recipientUnique: unique('shares_recipient_unique').on(
      table.entityType,
      table.entityId,
      table.recipientUserId,
    ),
  }),
);

export const pagePublicAccessVisits = pgTable(
  'page_public_access_visits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),
  },
  (table) => ({
    pageUserUnique: unique('page_public_access_visits_page_user_unique').on(
      table.pageId,
      table.userId,
    ),
    userIdx: index('page_public_access_visits_user_idx').on(table.userId),
  }),
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull().default('New Folder'),
    icon: text('icon'),
    position: text('position').notNull().default('0'),

    createdBy: uuid('created_by').references(() => users.id),

    createdAt: timestamp('created_at').defaultNow(),

    updatedAt: timestamp('updated_at').defaultNow(),

    isDeleted: boolean('is_deleted').default(false),

    deletedAt: timestamp('deleted_at'),

    deletionBatchId: uuid('deletion_batch_id'),

    publicPermission: text('public_permission').$type<'view' | 'edit'>(),

    inheritancePolicy: text('inheritance_policy')
      .notNull()
      .default('inherit')
      .$type<'inherit' | 'restricted'>(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    nameLength: check('folders_name_length_check', sql`char_length(${table.name}) <= 250`),
    positionNumeric: check(
      'folders_position_numeric_check',
      sql`char_length(${table.position}) <= 128 and ${table.position} ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'`,
    ),
    publicPermission: check(
      'folders_public_permission_check',
      sql`${table.publicPermission} is null or ${table.publicPermission} in ('view', 'edit')`,
    ),
  }),
);

export const folderClosure = pgTable(
  'folder_closure',
  {
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    descendantId: uuid('descendant_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (table) => ({
    pk: unique('folder_closure_pk').on(table.ancestorId, table.descendantId),
    descendantIdx: index('folder_closure_descendant_idx').on(table.descendantId),
    ancestorIdx: index('folder_closure_ancestor_idx').on(table.ancestorId),
  }),
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceOwnerId: uuid('workspace_owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('editor').$type<'viewer' | 'editor' | 'admin'>(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    ownerMemberUnique: unique('workspace_members_owner_member_unique').on(
      table.workspaceOwnerId,
      table.memberId,
    ),
  }),
);

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    parentId: uuid('parent_id').references(() => folders.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled'),
    titleRevision: bigint('title_revision', { mode: 'bigint' }).notNull().default(0n),
    titleSearch: tsvector('title_search'),
    contentSearch: text('content_search'),
    icon: text('icon'),
    coverType: text('cover_type'),
    coverValue: text('cover_value'),
    position: text('position').notNull().default('0'),
    ydoc: bytea('ydoc'),
    properties: customType<{ data: Record<string, unknown>; notNull: false; default: false }>({
      dataType() {
        return 'jsonb';
      },
    })('properties'),

    createdBy: uuid('created_by').references(() => users.id),

    publicPermission: text('public_permission').$type<'view' | 'edit'>(),

    inheritancePolicy: text('inheritance_policy')
      .notNull()
      .default('inherit')
      .$type<'inherit' | 'restricted'>(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at').defaultNow(),

    updatedAt: timestamp('updated_at').defaultNow(),

    isDeleted: boolean('is_deleted').default(false),

    deletedAt: timestamp('deleted_at'),

    deletionBatchId: uuid('deletion_batch_id'),
  },
  (table) => ({
    titleSearchIdx: index('pages_title_search_idx').using('gin', table.titleSearch),
    titleLength: check('pages_title_length_check', sql`char_length(${table.title}) <= 250`),
    positionNumeric: check(
      'pages_position_numeric_check',
      sql`char_length(${table.position}) <= 128 and ${table.position} ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'`,
    ),
    publicPermission: check(
      'pages_public_permission_check',
      sql`${table.publicPermission} is null or ${table.publicPermission} in ('view', 'edit')`,
    ),
  }),
);

export const pageVersions = pgTable(
  'page_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    content: customType<{ data: unknown; notNull: true; default: false }>({
      dataType() {
        return 'jsonb';
      },
    })('content').notNull(),
    title: text('title'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    titleLength: check(
      'page_versions_title_length_check',
      sql`${table.title} is null or char_length(${table.title}) <= 250`,
    ),
  }),
);

export const userFavorites = pgTable(
  'user_favorites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull().default('page').$type<'folder' | 'page'>(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    userEntityUnique: unique().on(table.userId, table.entityType, table.entityId),
    entityIdx: index('user_favorites_entity_idx').on(table.entityType, table.entityId),
  }),
);

export const pageVisits = pgTable(
  'page_visits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    visitedAt: timestamp('visited_at').defaultNow(),
  },
  (table) => ({
    userPageUnique: unique().on(table.userId, table.pageId),
  }),
);

export const folderPublicAccessVisits = pgTable(
  'folder_public_access_visits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    folderId: uuid('folder_id')
      .references(() => folders.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),
  },
  (table) => ({
    folderUserUnique: unique('folder_public_access_visits_folder_user_unique').on(
      table.folderId,
      table.userId,
    ),
    userIdx: index('folder_public_access_visits_user_idx').on(table.userId),
  }),
);

export const guestIdentities = pgTable(
  'guest_identities',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  },
  (table) => ({
    lastSeenIdx: index('guest_identities_last_seen_idx').on(table.lastSeenAt),
  }),
);

export const guestIdentityTombstones = pgTable(
  'guest_identity_tombstones',
  {
    id: uuid('id').primaryKey(),
    expiredAt: timestamp('expired_at').defaultNow().notNull(),
  },
  (table) => ({
    expiredAtIdx: index('guest_identity_tombstones_expired_at_idx').on(table.expiredAt),
  }),
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestId: uuid('guest_id').references(() => guestIdentities.id),
    content: text('content').notNull(),
    anchorBlockId: text('anchor_block_id'),
    resolved: boolean('resolved').default(false),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    author: check(
      'comments_author_check',
      sql`num_nonnulls(${table.userId}, ${table.guestId}) = 1`,
    ),
  }),
);

export const templates = pgTable('templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  icon: text('icon'),
  description: text('description'),
  contentBlocks: customType<{ data: unknown; notNull: true; default: false }>({
    dataType() {
      return 'jsonb';
    },
  })('content_blocks').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const commentReplies = pgTable(
  'comment_replies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestId: uuid('guest_id').references(() => guestIdentities.id),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    author: check(
      'comment_replies_author_check',
      sql`num_nonnulls(${table.userId}, ${table.guestId}) = 1`,
    ),
  }),
);

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceType: text('source_type').notNull().default('page'),
    sourceId: uuid('source_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    targetType: text('target_type').notNull().$type<'page' | 'tag' | 'user' | 'external'>(),
    targetId: uuid('target_id'),
    targetSlug: text('target_slug').notNull(),
    targetLabel: text('target_label').notNull(),
    connectionType: text('connection_type')
      .notNull()
      .$type<'wikilink' | 'tag' | 'mention' | 'embed' | 'heading' | 'url'>(),
    linkText: text('link_text'),
    linkContext: text('link_context'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    connectionUnique: unique().on(
      table.sourceType,
      table.sourceId,
      table.targetType,
      table.targetSlug,
      table.connectionType,
    ),
    sourceIdx: index('connections_source_idx').on(
      table.sourceType,
      table.sourceId,
      table.connectionType,
    ),
    targetIdIdx: index('connections_target_id_idx').on(
      table.targetType,
      table.targetId,
      table.connectionType,
    ),
    targetSlugIdx: index('connections_target_slug_idx').on(
      table.targetType,
      table.targetSlug,
      table.connectionType,
    ),
  }),
);

export const connectionOccurrences = pgTable(
  'connection_occurrences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    connectionId: uuid('connection_id')
      .references(() => connections.id, { onDelete: 'cascade' })
      .notNull(),
    sourceBlockId: text('source_block_id'),
    position: integer('position'),
    context: text('context'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    connectionIdx: index('connection_occurrences_connection_idx').on(table.connectionId),
  }),
);

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    filename: text('filename').notNull().unique(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'cascade' }),
    uploadedByGuestId: uuid('uploaded_by_guest_id').references(() => guestIdentities.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    uploader: check(
      'uploads_uploader_check',
      sql`num_nonnulls(${table.uploadedBy}, ${table.uploadedByGuestId}) = 1`,
    ),
  }),
);

export const uploadDeletionQueue = pgTable(
  'upload_deletion_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    filename: text('filename').notNull().unique(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    updatedAtIdx: index('upload_deletion_queue_updated_at_id_idx').on(table.updatedAt, table.id),
  }),
);

export const uploadPageRefs = pgTable(
  'upload_page_refs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    uploadId: uuid('upload_id')
      .references(() => uploads.id, { onDelete: 'cascade' })
      .notNull(),
    pageId: uuid('page_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    uploadPageUnique: unique('upload_page_refs_upload_page_unique').on(
      table.uploadId,
      table.pageId,
    ),
    uploadIdx: index('upload_page_refs_upload_idx').on(table.uploadId),
    pageIdx: index('upload_page_refs_page_idx').on(table.pageId),
  }),
);

// ======================
// Org / Workspace Tables (Phase 1)
// ======================

export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    archivedAt: timestamp('archived_at'),
  },
  (table) => ({
    slugFormat: check(
      'orgs_slug_format_check',
      sql`char_length(${table.slug}) between 1 and 50 and ${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    slugReserved: check(
      'orgs_slug_reserved_check',
      sql`${table.slug} not in ('admin', 'api', 'app', 'auth', 'login', 'logout', 'register', 'signup', 'static', 'www')`,
    ),
  }),
);

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'owner' | 'admin' | 'member'>(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: unique('org_members_pk').on(table.orgId, table.userId),
    userIdx: index('org_members_user_idx').on(table.userId),
    roleCheck: check(
      'org_members_role_check',
      sql`${table.role} in ('owner', 'admin', 'member')`,
    ),
  }),
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    visibility: text('visibility').notNull().default('open').$type<'open' | 'private'>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    archivedAt: timestamp('archived_at'),
  },
  (table) => ({
    orgSlugUnique: unique('workspaces_org_slug_unique').on(table.orgId, table.slug),
    slugFormat: check(
      'workspaces_slug_format_check',
      sql`char_length(${table.slug}) between 1 and 50 and ${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    visibilityCheck: check(
      'workspaces_visibility_check',
      sql`${table.visibility} in ('open', 'private')`,
    ),
  }),
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'admin' | 'editor' | 'viewer'>(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: unique('workspace_memberships_pk').on(table.workspaceId, table.userId),
    roleCheck: check(
      'workspace_memberships_role_check',
      sql`${table.role} in ('admin', 'editor', 'viewer')`,
    ),
  }),
);

export const inviteTokens = pgTable(
  'invite_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    emailIdx: index('invite_tokens_email_idx').on(table.email),
    expiresAtIdx: index('invite_tokens_expires_at_idx').on(table.expiresAt),
    orgEmailPendingUnique: uniqueIndex('invite_tokens_org_email_pending_unique')
      .on(table.orgId, table.email)
      .where(sql`${table.usedAt} is null`),
    roleCheck: check(
      'invite_tokens_role_check',
      sql`${table.role} in ('owner', 'admin', 'member', 'editor', 'viewer')`,
    ),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    orgIdx: index('audit_log_org_idx').on(table.orgId),
    actorIdx: index('audit_log_actor_idx').on(table.actorId),
    createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
  }),
);
