import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
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
  return { Cookie: `better-auth.session_token=${signedToken}` };
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

/**
 * Mock the pool.query to throw a specific error for the next call.
 * Returns a cleanup function that restores the original.
 *
 * @example
 *   const cleanup = mockDbError(new Error('connection lost'));
 *   // ... make request, expect 500
 *   cleanup();
 */
export function mockDbError(error: Error): () => void {
  const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(error);
  return () => spy.mockRestore();
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
};

export async function createTestVersion(
  pageId: string,
  userId: string,
  overrides?: CreateVersionOptions,
) {
  const id = randomUUID();
  const title = overrides?.title ?? 'Version';
  await pool.query(
    `INSERT INTO page_versions (id, page_id, title, created_by)
     VALUES ($1, $2, $3, $4)`,
    [id, pageId, title, userId],
  );
  return { id, pageId, title };
}

type CreateTemplateOptions = {
  name?: string;
  content?: string;
};

export async function createTestTemplate(
  workspaceId: string,
  userId: string,
  overrides?: CreateTemplateOptions,
) {
  const id = randomUUID();
  const name = overrides?.name ?? 'Test Template';
  const content = overrides?.content ?? '# Template content';
  await pool.query(
    `INSERT INTO templates (id, workspace_id, name, content, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, workspaceId, name, content, userId],
  );
  return { id, workspaceId, name };
}

type CreateTagOptions = {
  name?: string;
  color?: string | null;
};

export async function createTestTag(workspaceId: string, overrides?: CreateTagOptions) {
  const id = randomUUID();
  const name = overrides?.name ?? `tag-${randomUUID().slice(0, 6)}`;
  await pool.query(
    `INSERT INTO tags (id, workspace_id, name, color)
     VALUES ($1, $2, $3, $4)`,
    [id, workspaceId, name, overrides?.color ?? null],
  );
  return { id, workspaceId, name };
}

export async function createTestPageLink(sourcePageId: string, targetPageId: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO page_links (id, source_page_id, target_page_id)
     VALUES ($1, $2, $3)`,
    [id, sourcePageId, targetPageId],
  );
  return { id, sourcePageId, targetPageId };
}

export async function createTestPublicShare(pageId: string) {
  const id = randomUUID();
  const token = randomUUID();
  await pool.query(
    `INSERT INTO public_shares (id, page_id, token)
     VALUES ($1, $2, $3)`,
    [id, pageId, token],
  );
  return { id, pageId, token };
}

/**
 * Create a temporary directory for filesystem-backed test operations
 * (uploads, imports, exports). Returns the path and a cleanup function.
 * The directory is created under os.tmpdir() to avoid polluting the repo.
 */
export function createTestTempDir(prefix: string = 'markdawn-test-'): {
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
