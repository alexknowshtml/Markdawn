import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Custom bytea type for binary data
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// ======================
// Better Auth Tables
// ======================

export const sessions = pgTable('sessions', {
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
});

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

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerId: uuid('owner_id').references(() => users.id),
  isPersonal: boolean('is_personal').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member').$type<'owner' | 'admin' | 'member'>(),
  joinedAt: timestamp('joined_at').defaultNow(),
});

export const folders = pgTable('folders', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('New Folder'),
  icon: text('icon'),
  position: text('position').notNull().default('0'),

  createdBy: uuid('created_by').references(() => users.id),

  createdAt: timestamp('created_at').defaultNow(),

  updatedAt: timestamp('updated_at').defaultNow(),

  isDeleted: boolean('is_deleted').default(false),

  deletedAt: timestamp('deleted_at'),
});

export const pages = pgTable('pages', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references(() => folders.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Untitled'),
  titleSearch: text('title_search').generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(title, ''))`,
  ),
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

  createdAt: timestamp('created_at').defaultNow(),

  updatedAt: timestamp('updated_at').defaultNow(),

  isDeleted: boolean('is_deleted').default(false),

  deletedAt: timestamp('deleted_at'),
});

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
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    userPageUnique: unique().on(table.userId, table.pageId),
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
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
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

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    workspaceTagUnique: unique().on(table.workspaceId, table.name),
  }),
);

export const pageTags = pgTable(
  'page_tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pageId: uuid('page_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    tagId: uuid('tag_id')
      .references(() => tags.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (table) => ({
    pageTagUnique: unique().on(table.pageId, table.tagId),
  }),
);

export const pageLinks = pgTable(
  'page_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourcePageId: uuid('source_page_id')
      .references(() => pages.id, { onDelete: 'cascade' })
      .notNull(),
    targetPageId: uuid('target_page_id').references(() => pages.id, { onDelete: 'cascade' }),
    targetTitle: text('target_title').notNull(),
    linkText: text('link_text').notNull(),
    linkType: text('link_type').default('wiki').$type<'wiki' | 'heading' | 'embed'>(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    sourceTargetUnique: unique().on(table.sourcePageId, table.targetTitle),
  }),
);

export const uploads = pgTable('uploads', {
  id: uuid('id').defaultRandom().primaryKey(),
  filename: text('filename').notNull().unique(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .notNull(),
  uploadedBy: uuid('uploaded_by')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
