import { afterEach, beforeEach, vi } from 'vitest';
import { testQuery } from '../src/db/testQuery';

beforeEach(async () => {
  await testQuery('SET session_replication_role = replica');
  await testQuery(`
    DO $$ DECLARE t RECORD;
    BEGIN
      FOR t IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(t.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
  await testQuery('SET session_replication_role = default');
});

// Restore any vi.spyOn mocks after each test to prevent cascading failures
afterEach(() => {
  vi.restoreAllMocks();
});
