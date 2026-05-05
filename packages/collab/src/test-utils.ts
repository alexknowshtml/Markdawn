import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as Y from 'yjs';

export function getTestPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({ connectionString: url });
}

export async function createTestUser(pool: Pool) {
  const id = randomUUID();
  const email = `test-${id.slice(0, 8)}@example.com`;

  await pool.query(
    `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, true, NOW(), NOW())`,
    [id, email, 'Test User'],
  );

  return { id, email };
}

export async function createTestSession(pool: Pool, userId: string) {
  const token = randomUUID();
  const sessionId = randomUUID();

  await pool.query(
    `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW(), $3)`,
    [sessionId, token, userId],
  );

  return { token };
}

export async function createTestPage(
  pool: Pool,
  workspaceId: string,
  createdBy: string,
  ydoc?: Uint8Array,
) {
  const id = randomUUID();
  const title = 'Test Page';

  await pool.query(
    `INSERT INTO pages (id, workspace_id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
     VALUES ($1, $2, NULL, $3, '0', $4, NOW(), NOW(), $5)`,
    [id, workspaceId, title, createdBy, ydoc ?? null],
  );

  return { id, title };
}

export function createTestYjsDoc(content?: string): Uint8Array {
  const doc = new Y.Doc();
  if (content) {
    doc.getText('content').insert(0, content);
  }
  return Y.encodeStateAsUpdate(doc);
}

export function createCorruptedYjsDoc(): Uint8Array {
  return new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02, 0x03]);
}

export function createTestWorkspace() {
  const id = randomUUID();
  const name = `Test Workspace ${id.slice(0, 6)}`;

  return { id, name };
}

export async function insertTestWorkspace(
  pool: Pool,
  workspace: { id: string; name: string },
  ownerId: string,
) {
  await pool.query(
    `INSERT INTO workspaces (id, name, slug, owner_id, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, $4, false, NOW(), NOW())`,
    [workspace.id, workspace.name, `ws-${workspace.id.slice(0, 8)}`, ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, 'owner', NOW())`,
    [randomUUID(), workspace.id, ownerId],
  );
}
