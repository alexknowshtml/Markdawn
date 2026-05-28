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
  createdBy: string,
  title?: string,
  ydoc?: Uint8Array,
) {
  const id = randomUUID();
  const pageTitle = title ?? 'Test Page';

  await pool.query(
    `INSERT INTO pages (id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
     VALUES ($1, NULL, $2, '0', $3, NOW(), NOW(), $4)`,
    [id, pageTitle, createdBy, ydoc ?? null],
  );

  return { id, title: pageTitle };
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
