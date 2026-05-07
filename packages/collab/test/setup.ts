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

beforeEach(async () => {
  await pool.query('SET session_replication_role = replica');
  await pool.query(`
    DO $$ DECLARE t RECORD;
    BEGIN
      FOR t IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(t.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
  await pool.query('SET session_replication_role = default');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});
