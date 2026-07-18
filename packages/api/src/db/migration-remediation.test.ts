import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { db } from './connection';
import { executeQuery } from './query';

const currentDir = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(currentDir, '../../drizzle');

function readMigrationStatements(folder: string): string[] {
  return readFileSync(resolve(drizzleDir, folder, 'migration.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe('migration legacy-data remediation', () => {
  it('truncates a legacy over-limit title before adding the database constraint', async () => {
    await db.transaction(async (tx) => {
      await executeQuery(tx, 'set local search_path = pg_temp, public');
      await executeQuery(
        tx,
        `create temporary table pages (
           title text not null,
           title_search tsvector,
           updated_at timestamp
         ) on commit drop`,
      );
      await executeQuery(
        tx,
        `insert into pages (title, title_search)
         values ($1, to_tsvector('english', $1))`,
        ['📚'.repeat(251)],
      );

      for (const statement of readMigrationStatements('20260717113244_enforce_page_title_length')) {
        await executeQuery(tx, statement);
      }

      const row = await executeQuery<{
        title: string;
        title_length: number;
        search_matches: boolean;
        constraint_validated: boolean;
      }>(
        tx,
        `select
           title,
           char_length(title)::int as title_length,
           title_search = to_tsvector('english', title) as search_matches,
           (
             select convalidated
             from pg_constraint
             where conrelid = 'pg_temp.pages'::regclass
               and conname = 'pages_title_length_check'
           ) as constraint_validated
         from pages`,
      );
      expect(row.rows[0]).toEqual({
        title: '📚'.repeat(250),
        title_length: 250,
        search_matches: true,
        constraint_validated: true,
      });
    });
  });

  it('downgrades legacy admin links and their events before adding the link constraint', async () => {
    await db.transaction(async (tx) => {
      await executeQuery(tx, 'set local search_path = pg_temp, public');
      await executeQuery(
        tx,
        `create temporary table shares (
           entity_type text not null,
           entity_id uuid not null,
           token text,
           permission text not null,
           updated_at timestamp
         ) on commit drop`,
      );
      await executeQuery(
        tx,
        `create temporary table page_access_events (
           page_id uuid not null,
           token text not null,
           permission text not null
         ) on commit drop`,
      );
      await executeQuery(
        tx,
        `create temporary table folder_access_events (
           folder_id uuid not null,
           token text not null,
           permission text not null
         ) on commit drop`,
      );
      const pageId = crypto.randomUUID();
      const folderId = crypto.randomUUID();
      await executeQuery(
        tx,
        `insert into shares (entity_type, entity_id, token, permission)
         values ('page', $1, 'page-token', 'admin'), ('folder', $2, 'folder-token', 'admin')`,
        [pageId, folderId],
      );
      await executeQuery(tx, `insert into page_access_events values ($1, 'page-token', 'admin')`, [
        pageId,
      ]);
      await executeQuery(
        tx,
        `insert into folder_access_events values ($1, 'folder-token', 'admin')`,
        [folderId],
      );

      for (const statement of readMigrationStatements(
        '20260717114054_enforce_public_link_permissions',
      )) {
        await executeQuery(tx, statement);
      }

      const result = await executeQuery<{
        share_permissions: string[];
        page_permission: string;
        folder_permission: string;
        constraint_validated: boolean;
      }>(
        tx,
        `select
           array(select permission from shares order by entity_type) as share_permissions,
           (select permission from page_access_events) as page_permission,
           (select permission from folder_access_events) as folder_permission,
           (
             select convalidated
             from pg_constraint
             where conrelid = 'pg_temp.shares'::regclass
               and conname = 'shares_public_link_permission_check'
           ) as constraint_validated`,
      );
      expect(result.rows[0]).toEqual({
        share_permissions: ['edit', 'edit'],
        page_permission: 'edit',
        folder_permission: 'edit',
        constraint_validated: true,
      });
    });
  });

  it('truncates a legacy over-limit version title before adding the snapshot constraint', async () => {
    await db.transaction(async (tx) => {
      await executeQuery(tx, 'set local search_path = pg_temp, public');
      await executeQuery(
        tx,
        `create temporary table page_versions (
           title text
         ) on commit drop`,
      );
      await executeQuery(tx, 'insert into page_versions (title) values ($1)', ['📚'.repeat(251)]);

      for (const statement of readMigrationStatements(
        '20260717115547_enforce_page_version_title_length',
      )) {
        await executeQuery(tx, statement);
      }

      const row = await executeQuery<{
        title: string;
        title_length: number;
        constraint_validated: boolean;
      }>(
        tx,
        `select
           title,
           char_length(title)::int as title_length,
           (
             select convalidated
             from pg_constraint
             where conrelid = 'pg_temp.page_versions'::regclass
               and conname = 'page_versions_title_length_check'
           ) as constraint_validated
         from page_versions`,
      );
      expect(row.rows[0]).toEqual({
        title: '📚'.repeat(250),
        title_length: 250,
        constraint_validated: true,
      });
    });
  });

  it('moves legacy active descendants into the nearest deleted ancestor batch', async () => {
    await db.transaction(async (tx) => {
      await executeQuery(tx, 'set local search_path = pg_temp, public');
      await executeQuery(
        tx,
        `create temporary table folders (
           id uuid primary key,
           is_deleted boolean not null,
           deleted_at timestamp,
           deletion_batch_id uuid,
           updated_at timestamp
         ) on commit drop`,
      );
      await executeQuery(
        tx,
        `create temporary table folder_closure (
           ancestor_id uuid not null,
           descendant_id uuid not null,
           depth integer not null
         ) on commit drop`,
      );
      await executeQuery(
        tx,
        `create temporary table pages (
           id uuid primary key,
           parent_id uuid,
           is_deleted boolean not null,
           deleted_at timestamp,
           deletion_batch_id uuid,
           updated_at timestamp
         ) on commit drop`,
      );

      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      const nearerDeletedId = crypto.randomUUID();
      const leafId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const rootBatchId = crypto.randomUUID();
      const nearerBatchId = crypto.randomUUID();
      await executeQuery(
        tx,
        `insert into folders (id, is_deleted, deleted_at, deletion_batch_id)
         values
           ($1, true, '2026-01-01 00:00:00', $5),
           ($2, false, null, null),
           ($3, true, '2026-02-01 00:00:00', $6),
           ($4, false, null, null)`,
        [rootId, childId, nearerDeletedId, leafId, rootBatchId, nearerBatchId],
      );
      await executeQuery(
        tx,
        `insert into folder_closure (ancestor_id, descendant_id, depth)
         values
           ($1, $1, 0),
           ($1, $2, 1), ($2, $2, 0),
           ($1, $3, 2), ($2, $3, 1), ($3, $3, 0),
           ($1, $4, 3), ($2, $4, 2), ($3, $4, 1), ($4, $4, 0)`,
        [rootId, childId, nearerDeletedId, leafId],
      );
      await executeQuery(
        tx,
        `insert into pages (id, parent_id, is_deleted)
         values ($1, $2, false)`,
        [pageId, leafId],
      );

      for (const statement of readMigrationStatements(
        '20260717120609_remediate_deleted_folder_descendants',
      )) {
        await executeQuery(tx, statement);
      }

      const result = await executeQuery<{
        child_deleted: boolean;
        child_batch: string | null;
        leaf_deleted: boolean;
        leaf_batch: string | null;
        page_deleted: boolean;
        page_batch: string | null;
      }>(
        tx,
        `select
           child.is_deleted as child_deleted,
           child.deletion_batch_id::text as child_batch,
           leaf.is_deleted as leaf_deleted,
           leaf.deletion_batch_id::text as leaf_batch,
           page.is_deleted as page_deleted,
           page.deletion_batch_id::text as page_batch
         from folders child
         join folders leaf on leaf.id = $2
         join pages page on page.id = $3
         where child.id = $1`,
        [childId, leafId, pageId],
      );
      expect(result.rows[0]).toEqual({
        child_deleted: true,
        child_batch: rootBatchId,
        leaf_deleted: true,
        leaf_batch: nearerBatchId,
        page_deleted: true,
        page_batch: nearerBatchId,
      });
    });
  });
});
