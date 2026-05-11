import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';

// HocuspocusProvider requires a WebSocket global in Node.js
// TODO: Remove this polyfill when upgrading to Node.js 24, which has built-in WebSocket
// See: https://github.com/nodejs/node/issues/46096
(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = WebSocket;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function truncateTables(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query('SET session_replication_role = replica');
      try {
        await pool.query(`
          DO $$ DECLARE t RECORD;
          BEGIN
            FOR t IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
            LOOP
              EXECUTE 'TRUNCATE TABLE ' || quote_ident(t.tablename) || ' RESTART IDENTITY CASCADE';
            END LOOP;
          END $$;
        `);
        return;
      } finally {
        await pool.query('SET session_replication_role = default');
      }
    } catch (err) {
      const pgErr = err as { code?: string } | undefined;
      if (pgErr?.code === '40P01' && attempt < 3) {
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      throw err;
    }
  }
}

beforeEach(truncateTables);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});
