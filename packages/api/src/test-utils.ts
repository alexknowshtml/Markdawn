import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from './app';
import { pool } from './db/connection';

export async function createTestApp() {
  return createApp();
}

type CreateUserOptions = {
  email?: string;
  name?: string;
};

export async function createTestUser(overrides?: CreateUserOptions) {
  const id = randomUUID();
  const email = overrides?.email ?? `test-${id.slice(0, 8)}@example.com`;
  const name = overrides?.name ?? 'Test User';

  await pool.query(
    `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, true, NOW(), NOW())`,
    [id, email, name],
  );

  // Mirror ensurePersonalWorkspace from auth.ts:
  // Better Auth's databaseHooks.user.create.after normally does this,
  // but we bypass the hook by inserting directly into users.
  const workspaceId = randomUUID();
  const slug = `personal-${randomUUID().slice(0, 6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, name, slug, owner_id, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
    [workspaceId, `${name}'s Workspace`, slug, id],
  );
  await pool.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, 'owner', NOW())`,
    [randomUUID(), workspaceId, id],
  );

  return { id, email, name, workspaceId };
}

/**
 * Sign a session token using HMAC-SHA256, matching Hono's signed cookie format.
 * `parseSigned` in `hono/utils/cookie` expects: `value.base64(HMAC-SHA256(secret, value))`
 * where the base64 signature is 44 characters ending with ==.
 */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  const base64sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${value}.${base64sig}`;
}

export async function createTestSession(userId: string) {
  const token = randomUUID();
  const sessionId = randomUUID();
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  const signedToken = await signCookieValue(token, secret);

  await pool.query(
    `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW(), $3)`,
    [sessionId, token, userId],
  );
  return { Cookie: `better-auth.session_token=${signedToken}`, token: signedToken };
}

type CreateWorkspaceOptions = {
  name?: string;
  slug?: string;
};

export async function createTestWorkspace(ownerId: string, overrides?: CreateWorkspaceOptions) {
  const id = randomUUID();
  const name = overrides?.name ?? 'Test Workspace';
  const slug = overrides?.slug ?? `ws-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO workspaces (id, name, slug, owner_id, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, $4, false, NOW(), NOW())`,
    [id, name, slug, ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, 'owner', NOW())`,
    [randomUUID(), id, ownerId],
  );
  return { id, name, slug };
}

type CreatePageOptions = {
  title?: string;
  parentId?: string | null;
};

export async function createTestPage(
  workspaceId: string,
  createdBy: string,
  overrides?: CreatePageOptions,
) {
  const id = randomUUID();
  const title = overrides?.title ?? 'Test Page';
  await pool.query(
    `INSERT INTO pages (id, workspace_id, parent_id, title, position, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '0', $5, NOW(), NOW())`,
    [id, workspaceId, overrides?.parentId ?? null, title, createdBy],
  );
  return { id, title, workspaceId };
}

type CreateFolderOptions = {
  name?: string;
  parentId?: string | null;
  icon?: string | null;
};

export async function createTestFolder(
  workspaceId: string,
  createdBy: string,
  overrides?: CreateFolderOptions,
) {
  const id = randomUUID();
  const name = overrides?.name ?? 'Test Folder';
  await pool.query(
    `INSERT INTO folders (id, workspace_id, parent_id, name, icon, position, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '0', $6, NOW(), NOW())`,
    [id, workspaceId, overrides?.parentId ?? null, name, overrides?.icon ?? null, createdBy],
  );
  return { id, name, workspaceId };
}

type CreateCommentOptions = {
  content?: string;
  anchorBlockId?: string | null;
};

export async function createTestComment(
  pageId: string,
  userId: string,
  overrides?: CreateCommentOptions,
) {
  const id = randomUUID();
  const content = overrides?.content ?? 'Test comment';
  await pool.query(
    `INSERT INTO comments (id, page_id, user_id, content, anchor_block_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, pageId, userId, content, overrides?.anchorBlockId ?? null],
  );
  return { id, pageId, userId, content };
}

type CreateReplyOptions = {
  content?: string;
};

export async function createTestReply(
  commentId: string,
  userId: string,
  overrides?: CreateReplyOptions,
) {
  const id = randomUUID();
  const content = overrides?.content ?? 'Test reply';
  await pool.query(
    `INSERT INTO comment_replies (id, comment_id, user_id, content)
     VALUES ($1, $2, $3, $4)`,
    [id, commentId, userId, content],
  );
  return { id, commentId, userId, content };
}

type CreateVersionOptions = {
  title?: string;
  content?: unknown;
};

export async function createTestVersion(
  pageId: string,
  userId: string,
  overrides?: CreateVersionOptions,
) {
  const id = randomUUID();
  const title = overrides?.title ?? 'Version';
  const content = overrides?.content ?? { type: 'doc', content: [] };
  await pool.query(
    `INSERT INTO page_versions (id, page_id, title, content, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [id, pageId, title, JSON.stringify(content), userId],
  );
  return { id, pageId, title };
}

type CreateTemplateOptions = {
  title?: string;
  contentBlocks?: unknown;
};

export async function createTestTemplate(
  workspaceId: string,
  userId: string,
  overrides?: CreateTemplateOptions,
) {
  const id = randomUUID();
  const title = overrides?.title ?? 'Test Template';
  const contentBlocks = overrides?.contentBlocks ?? { type: 'doc', content: [] };
  await pool.query(
    `INSERT INTO templates (id, workspace_id, title, content_blocks, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [id, workspaceId, title, JSON.stringify(contentBlocks), userId],
  );
  return { id, workspaceId, title };
}

export async function createTestPageLink(sourcePageId: string, targetPageId: string) {
  const id = randomUUID();
  const sourceResult = await pool.query<{ workspace_id: string }>(
    'select workspace_id from pages where id = $1 limit 1',
    [sourcePageId],
  );
  const targetResult = await pool.query<{ title: string }>(
    'select title from pages where id = $1 limit 1',
    [targetPageId],
  );
  const workspaceId = sourceResult.rows[0]?.workspace_id;
  const targetTitle = targetResult.rows[0]?.title ?? 'target';
  if (!workspaceId) {
    throw new Error(`source page not found: ${sourcePageId}`);
  }

  await pool.query(
    `INSERT INTO connections (
       id, workspace_id, source_type, source_id, target_type, target_id, target_slug,
       target_label, connection_type, link_text, occurrence_count, updated_at
     )
     VALUES ($1, $2, 'page', $3, 'page', $4, $5, $6, 'wikilink', 'link', 1, NOW())`,
    [id, workspaceId, sourcePageId, targetPageId, targetTitle.toLowerCase(), targetTitle],
  );
  return { id, sourcePageId, targetPageId };
}

export async function createTestPublicShare(pageId: string) {
  const token = randomUUID();
  await pool.query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
    token,
    pageId,
  ]);
  return { pageId, token };
}

/**
 * Create a temporary directory for filesystem-backed test operations
 * (uploads, imports, exports). Returns the path and a cleanup function.
 * The directory is created under os.tmpdir() to avoid polluting the repo.
 */
export function createTestTempDir(prefix = 'markdawn-test-'): {
  path: string;
  cleanup: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        void 0;
      }
    },
  };
}

/**
 * Create a temporary file inside a temp directory with the given content.
 * Returns the full file path.
 */
export function createTestTempFile(
  dirPath: string,
  fileName: string,
  content: string | Buffer,
): string {
  const filePath = join(dirPath, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

// NOTE: We intentionally do not export a `mockDbError` helper or test the
// `rowCount === 0` branches after INSERT/UPDATE. In production, Postgres
// either succeeds with rowCount > 0 or throws an exception. The rowCount === 0
// checks are defensive guards for impossible states; testing them would require
// mocking pool.query, which undermines the value of integration tests that use
// a real database.
