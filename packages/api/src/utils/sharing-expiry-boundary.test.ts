import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { createTestFolder, createTestPage, createTestUser } from '../test-utils';

type CanonicalWrapperSnapshot = {
  accessible_page: boolean;
  base_permission: boolean;
  folder_permission: string | null;
  page_permission: string | null;
};

async function readCanonicalWrapperSnapshot(
  client: Client,
  pageId: string,
  folderId: string,
  recipientId: string,
): Promise<CanonicalWrapperSnapshot> {
  const result = await client.query<CanonicalWrapperSnapshot>(
    `select
       (select permission from get_effective_page_permission($1, $3)) as page_permission,
       (select permission from get_effective_folder_permission($2, $3)) as folder_permission,
       exists (
         select 1
         from get_page_base_permissions($1)
         where user_id = $3
       ) as base_permission,
       exists (
         select 1
         from get_accessible_page_ids($3)
         where page_id = $1
       ) as accessible_page`,
    [pageId, folderId, recipientId],
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error('Canonical permission wrappers returned no snapshot');
  return snapshot;
}

describe('deterministic sharing expiry boundaries', () => {
  it('keeps every live canonical wrapper pinned to statement time', async () => {
    const result = await query<{ definition: string; function_name: string }>(
      `select wrapper.function_name,
              pg_get_functiondef(to_regprocedure(wrapper.signature)) as definition
       from (values
         ('get_effective_page_permission', 'get_effective_page_permission(uuid,uuid)'),
         ('get_effective_folder_permission', 'get_effective_folder_permission(uuid,uuid)'),
         ('get_page_base_permissions', 'get_page_base_permissions(uuid)'),
         ('get_accessible_page_ids', 'get_accessible_page_ids(uuid)')
       ) wrapper(function_name, signature)
       order by wrapper.function_name`,
    );

    expect(result.rows).toHaveLength(4);
    for (const wrapper of result.rows) {
      const delegatesWithStatementTime = new RegExp(
        `\\b${wrapper.function_name}_at\\s*\\([^;]*\\bstatement_timestamp\\s*\\(\\s*\\)`,
        'i',
      );
      expect(
        wrapper.definition,
        `${wrapper.function_name} must delegate with statement time`,
      ).toMatch(delegatesWithStatementTime);
      expect(wrapper.definition, `${wrapper.function_name} must not use NOW()`).not.toMatch(
        /\bnow\s*\(/i,
      );
      expect(
        wrapper.definition,
        `${wrapper.function_name} must not use transaction_timestamp()`,
      ).not.toMatch(/\btransaction_timestamp\s*\(/i);
      expect(
        wrapper.definition,
        `${wrapper.function_name} must not use CURRENT_TIMESTAMP`,
      ).not.toMatch(/\bcurrent_timestamp\b/i);
    }
  });

  it('re-evaluates every canonical wrapper after expiry inside a pre-expiry transaction', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');

    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id);
    const client = new Client({ connectionString });
    let transactionOpen = false;

    await client.connect();
    try {
      await client.query('begin');
      transactionOpen = true;

      const pageShare = await query<{ expires_at: Date }>(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
         ) values ('page', $1, $2, $3, 'view', clock_timestamp() + interval '2 seconds')
         returning expires_at`,
        [page.id, owner.id, recipient.id],
      );
      const expiresAt = pageShare.rows[0]?.expires_at;
      if (!expiresAt) throw new Error('Expiring page grant was not created');

      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
         ) values ('folder', $1, $2, $3, 'view', $4)`,
        [folder.id, owner.id, recipient.id, expiresAt],
      );

      const beforeTiming = await client.query<{ started_before_expiry: boolean }>(
        'select transaction_timestamp() < $1::timestamptz as started_before_expiry',
        [expiresAt],
      );
      expect(beforeTiming.rows[0]?.started_before_expiry).toBe(true);
      expect(await readCanonicalWrapperSnapshot(client, page.id, folder.id, recipient.id)).toEqual({
        accessible_page: true,
        base_permission: true,
        folder_permission: 'view',
        page_permission: 'view',
      });

      await client.query(
        `select pg_sleep(
           greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.05
         )`,
        [expiresAt],
      );
      const afterTiming = await client.query<{ expired: boolean }>(
        'select clock_timestamp() >= $1::timestamptz as expired',
        [expiresAt],
      );
      expect(afterTiming.rows[0]?.expired).toBe(true);

      expect(await readCanonicalWrapperSnapshot(client, page.id, folder.id, recipient.id)).toEqual({
        accessible_page: false,
        base_permission: false,
        folder_permission: null,
        page_permission: null,
      });

      await client.query('commit');
      transactionOpen = false;
    } finally {
      if (transactionOpen) await client.query('rollback');
      await client.end();
    }
  });

  it('expires a winning page grant exactly at expiresAt and activates fallback', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    const expiresAt = '2030-01-01T00:00:00.000Z';

    await query(
      `INSERT INTO shares (
         entity_type, entity_id, shared_by, recipient_user_id, permission
       ) VALUES ('folder', $1, $2, $3, 'view')`,
      [folder.id, owner.id, recipient.id],
    );
    await query(
      `INSERT INTO shares (
         entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
       ) VALUES ('page', $1, $2, $3, 'edit', $4)`,
      [page.id, owner.id, recipient.id, expiresAt],
    );

    const before = await query<{ permission: string | null }>(
      'SELECT permission FROM get_effective_page_permission_at($1, $2, $3)',
      [page.id, recipient.id, '2029-12-31T23:59:59.999Z'],
    );
    const exact = await query<{ permission: string | null }>(
      'SELECT permission FROM get_effective_page_permission_at($1, $2, $3)',
      [page.id, recipient.id, expiresAt],
    );
    const after = await query<{ permission: string | null }>(
      'SELECT permission FROM get_effective_page_permission_at($1, $2, $3)',
      [page.id, recipient.id, '2030-01-01T00:00:00.001Z'],
    );

    expect(before.rows[0]?.permission).toBe('edit');
    expect(exact.rows[0]?.permission).toBe('view');
    expect(after.rows[0]?.permission).toBe('view');

    const baseAtExpiry = await query<{ permission: string }>(
      'SELECT permission FROM get_page_base_permissions_at($1, $2) WHERE user_id = $3',
      [page.id, expiresAt, recipient.id],
    );
    expect(baseAtExpiry.rows[0]?.permission).toBe('view');

    const accessibleAtExpiry = await query<{ page_id: string }>(
      'SELECT page_id FROM get_accessible_page_ids_at($1, $2) WHERE page_id = $3',
      [recipient.id, expiresAt, page.id],
    );
    expect(accessibleAtExpiry.rows).toEqual([{ page_id: page.id }]);
  });

  it('expires a winning folder grant exactly at expiresAt', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const expiresAt = '2030-01-01T00:00:00.000Z';

    await query(
      `INSERT INTO workspace_members (workspace_owner_id, member_id, role)
       VALUES ($1, $2, 'viewer')`,
      [owner.id, recipient.id],
    );
    await query(
      `INSERT INTO shares (
         entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
       ) VALUES ('folder', $1, $2, $3, 'edit', $4)`,
      [folder.id, owner.id, recipient.id, expiresAt],
    );

    const before = await query<{ permission: string | null }>(
      'SELECT permission FROM get_effective_folder_permission_at($1, $2, $3)',
      [folder.id, recipient.id, '2029-12-31T23:59:59.999Z'],
    );
    const exact = await query<{ permission: string | null }>(
      'SELECT permission FROM get_effective_folder_permission_at($1, $2, $3)',
      [folder.id, recipient.id, expiresAt],
    );

    expect(before.rows[0]?.permission).toBe('edit');
    expect(exact.rows[0]?.permission).toBe('view');
  });

  it('evaluates the same absolute boundary in a non-UTC database session', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const page = await createTestPage(owner.id);
    const expiresAt = '2030-01-01T00:00:00.000Z';
    await query(
      `insert into shares (
         entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
       ) values ('page', $1, $2, $3, 'edit', $4)`,
      [page.id, owner.id, recipient.id, expiresAt],
    );

    await db.transaction(async (tx) => {
      await executeQuery(tx, `set local time zone 'Asia/Kolkata'`);
      const before = await executeQuery<{ permission: string | null }>(
        tx,
        'select permission from get_effective_page_permission_at($1, $2, $3)',
        [page.id, recipient.id, '2029-12-31T23:59:59.999Z'],
      );
      const exact = await executeQuery<{ permission: string | null }>(
        tx,
        'select permission from get_effective_page_permission_at($1, $2, $3)',
        [page.id, recipient.id, expiresAt],
      );

      expect(before.rows[0]?.permission).toBe('edit');
      expect(exact.rows[0]?.permission).toBeNull();
    });
  });
});
