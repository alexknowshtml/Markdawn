import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';

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
