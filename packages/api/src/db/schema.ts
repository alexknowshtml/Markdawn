import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: boolean('email_verified').default(false),
  image: text('image'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const shares = pgTable(
  'shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entityType: text('entity_type').notNull().$type<'folder' | 'page'>(),
    entityId: uuid('entity_id').notNull(),
    sharedBy: uuid('shared_by').references(() => users.id, { onDelete: 'set null' }),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    recipientEmail: text('recipient_email'),
    permission: text('permission').notNull().default('view').$type<'view' | 'edit' | 'admin'>(),
    token: text('token').unique(),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    entityIdx: index('shares_entity_idx').on(table.entityType, table.entityId),
    recipientIdx: index('shares_recipient_idx').on(table.recipientUserId),
    tokenIdx: index('shares_token_idx').on(table.token),
    expiresAtIdx: index('shares_expires_at_idx').on(table.expiresAt),
    inviteUnique: unique('shares_invite_unique').on(
      table.entityType,
      table.entityId,
      table.recipientUserId,
    ),
    linkUnique: uniqueIndex('shares_link_unique')
      .on(table.entityType, table.entityId)
      .where(sql`${table.token} is not null`),
  }),
);

export const pageAccessEvents = pgTable(
  'page_access_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    source: text('source').notNull().default('link').$type<'link'>(),
    token: text('token').notNull(),
    permission: text('permission').notNull().$type<'view' | 'edit' | 'admin'>(),
    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),
  },
  (table) => ({
    pageUserSourceUnique: unique().on(table.pageId, table.userId, table.source, table.token),
    pageUserIdx: index('page_access_events_page_user_idx').on(table.pageId, table.userId),
    tokenIdx: index('page_access_events_token_idx').on(table.token),
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

    isPublic: boolean('is_public').default(false),

    publicToken: text('public_token'),

    inheritancePolicy: text('inheritance_policy')
      .notNull()
      .default('inherit')
      .$type<'inherit' | 'restricted'>(),
  },
  (table) => ({
    positionNumeric: check(
      'folders_position_numeric_check',
      sql`char_length(${table.position}) <= 128 and ${table.position} ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'`,
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

    isPublic: boolean('is_public').default(false),
    publicToken: text('public_token').unique(),

    inheritancePolicy: text('inheritance_policy')
      .notNull()
      .default('inherit')
      .$type<'inherit' | 'restricted'>(),

    createdAt: timestamp('created_at').defaultNow(),

    updatedAt: timestamp('updated_at').defaultNow(),

    isDeleted: boolean('is_deleted').default(false),

    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    titleSearchIdx: index('pages_title_search_idx').using('gin', table.titleSearch),
    positionNumeric: check(
      'pages_position_numeric_check',
      sql`char_length(${table.position}) <= 128 and ${table.position} ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'`,
    ),
  }),
);

export const pageVersions = pgTable('page_versions', {
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
});

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

export const folderAccessEvents = pgTable(
  'folder_access_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    folderId: uuid('folder_id')
      .references(() => folders.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    source: text('source').notNull().default('link').$type<'link'>(),
    token: text('token').notNull(),
    permission: text('permission').notNull().$type<'view' | 'edit' | 'admin'>(),
    firstSeenAt: timestamp('first_seen_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),
  },
  (table) => ({
    folderUserSourceUnique: unique().on(table.folderId, table.userId, table.source, table.token),
    folderUserIdx: index('folder_access_events_folder_user_idx').on(table.folderId, table.userId),
    tokenIdx: index('folder_access_events_token_idx').on(table.token),
  }),
);

export const comments = pgTable('comments', {
  id: uuid('id').defaultRandom().primaryKey(),
  pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  anchorBlockId: text('anchor_block_id'),
  resolved: boolean('resolved').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

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
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const commentReplies = pgTable('comment_replies', {
  id: uuid('id').defaultRandom().primaryKey(),
  commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

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

export const uploads = pgTable('uploads', {
  id: uuid('id').defaultRandom().primaryKey(),
  filename: text('filename').notNull().unique(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  uploadedBy: uuid('uploaded_by')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

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
