import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { testQuery } from '../db/testQuery';
import { createTestFolder, createTestUser } from '../test-utils';
import { copyFolderRecursive } from './folderCopy';

const FAILURE_FUNCTION = 'fail_later_folder_copy_batch';
const FAILURE_TRIGGER = 'test_fail_later_folder_copy_batch';

async function removeFailureTrigger(): Promise<void> {
  await testQuery(`drop trigger if exists ${FAILURE_TRIGGER} on pages`);
  await testQuery(`drop function if exists ${FAILURE_FUNCTION}()`);
}

describe('folder copy transactions', () => {
  afterEach(removeFailureTrigger);

  it('rolls back earlier batches when a later page batch fails', async () => {
    await removeFailureTrigger();
    const owner = await createTestUser();
    const source = await createTestFolder(owner.id, { name: 'Batch source' });
    const marker = `later-batch-${crypto.randomUUID()}`;
    await testQuery(
      `insert into pages (parent_id, title, position, created_by)
       select $1, case when index = 100 then $2 else 'Page ' || index end,
              index::text, $3
       from generate_series(0, 100) as index`,
      [source.id, marker, owner.id],
    );
    await testQuery(
      `create function ${FAILURE_FUNCTION}() returns trigger language plpgsql as $$
       begin
         if new.title like $trigger$%${marker}%$trigger$ then
           raise exception 'forced later copy batch failure';
         end if;
         return new;
       end $$`,
    );
    await testQuery(
      `create trigger ${FAILURE_TRIGGER} before insert on pages
       for each row execute function ${FAILURE_FUNCTION}()`,
    );

    await expect(
      db.transaction((tx) =>
        copyFolderRecursive(tx, source.id, null, owner.id, { kind: 'user', id: owner.id }, 'all'),
      ),
    ).rejects.toThrow('forced later copy batch failure');

    const folderCount = await executeQuery<{ count: string }>(
      db,
      sql`select count(*)::text as count from folders where created_by = ${owner.id}`,
    );
    const pageCount = await executeQuery<{ count: string }>(
      db,
      sql`select count(*)::text as count from pages where created_by = ${owner.id}`,
    );
    expect(folderCount.rows[0]?.count).toBe('1');
    expect(pageCount.rows[0]?.count).toBe('101');
  });

  it('supports repeated copies within the same transaction', async () => {
    const owner = await createTestUser();
    const source = await createTestFolder(owner.id, { name: 'Repeatable source' });

    const [first, second] = await db.transaction(async (tx) => [
      await copyFolderRecursive(
        tx,
        source.id,
        null,
        owner.id,
        { kind: 'user', id: owner.id },
        'all',
      ),
      await copyFolderRecursive(
        tx,
        source.id,
        null,
        owner.id,
        { kind: 'user', id: owner.id },
        'all',
      ),
    ]);

    expect(first.folder).toMatchObject({ name: 'Copy of Repeatable source', ownerId: owner.id });
    expect(second.folder).toMatchObject({ name: 'Copy of Repeatable source', ownerId: owner.id });
    expect(second.folder?.id).not.toBe(first.folder?.id);
  });
});
