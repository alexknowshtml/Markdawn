import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

type ExpiringWriteOptions = {
  entityType: 'folder' | 'page';
  permission: 'admin' | 'edit';
  originalValue: string;
  createEntity: (ownerId: string) => Promise<{ id: string }>;
  request: (entityId: string, sessionCookie: string) => Response | Promise<Response>;
  readStoredValue: (entityId: string) => Promise<string | undefined>;
};

async function waitForBlockedPid(blockerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await query<{ pid: number }>(
      `select pid
       from pg_stat_activity
       where $1 = any(pg_blocking_pids(pid))
       order by pid
       limit 1`,
      [blockerPid],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a request blocked by PID ${blockerPid}`);
}

async function waitForShareExpiry(shareId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await query<{ expired: boolean }>(
      `select clock_timestamp() >= expires_at as expired
       from shares
       where id = $1`,
      [shareId],
    );
    if (result.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for share ${shareId} to expire`);
}

async function runExpiringGrantWriteBarrier(options: ExpiringWriteOptions): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const owner = await createTestUser();
  const collaborator = await createTestUser();
  const session = await createTestSession(collaborator.id);
  const entity = await options.createEntity(owner.id);
  const lockKey = `workspace-access:${owner.id}`;
  const blocker = new Client({ connectionString });
  let blockerTransactionOpen = false;
  let requestPromise: Promise<Response> | null = null;

  await blocker.connect();
  try {
    await blocker.query('begin');
    blockerTransactionOpen = true;
    const blockerPidResult = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid');
    const blockerPid = blockerPidResult.rows[0]?.pid;
    if (blockerPid === undefined) throw new Error('Failed to resolve blocker PID');
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

    const share = await query<{ id: string }>(
      `insert into shares (
         entity_type, entity_id, shared_by, recipient_user_id, recipient_email,
         permission, expires_at
       ) values ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '3 seconds')
       returning id`,
      [
        options.entityType,
        entity.id,
        owner.id,
        collaborator.id,
        collaborator.email,
        options.permission,
      ],
    );
    const shareId = share.rows[0]?.id;
    if (!shareId) throw new Error('Failed to create expiring share');

    const pendingRequest = Promise.resolve(options.request(entity.id, session.Cookie));
    requestPromise = pendingRequest;
    const requestPid = await waitForBlockedPid(blockerPid);

    const preExpiryTiming = await query<{
      blocked_by_expected_pid: boolean;
      started_before_expiry: boolean;
    }>(
      `select $1 = any(pg_blocking_pids(activity.pid)) as blocked_by_expected_pid,
              activity.xact_start < share.expires_at as started_before_expiry
       from pg_stat_activity activity
       join shares share on share.id = $3
       where activity.pid = $2`,
      [blockerPid, requestPid, shareId],
    );
    expect(preExpiryTiming.rows[0]).toEqual({
      blocked_by_expected_pid: true,
      started_before_expiry: true,
    });

    await waitForShareExpiry(shareId);
    const postExpiryTiming = await query<{
      blocked_by_expected_pid: boolean;
      expired: boolean;
      started_before_expiry: boolean;
    }>(
      `select $1 = any(pg_blocking_pids(activity.pid)) as blocked_by_expected_pid,
              clock_timestamp() >= share.expires_at as expired,
              activity.xact_start < share.expires_at as started_before_expiry
       from pg_stat_activity activity
       join shares share on share.id = $3
       where activity.pid = $2`,
      [blockerPid, requestPid, shareId],
    );
    expect(postExpiryTiming.rows[0]).toEqual({
      blocked_by_expected_pid: true,
      expired: true,
      started_before_expiry: true,
    });

    await blocker.query('rollback');
    blockerTransactionOpen = false;
    const response = await pendingRequest;
    expect(response.status).toBe(403);
    expect(await options.readStoredValue(entity.id)).toBe(options.originalValue);
    return response;
  } finally {
    if (blockerTransactionOpen) await blocker.query('rollback');
    await blocker.end();
    if (requestPromise) await Promise.allSettled([requestPromise]);
  }
}

describe('share expiration write atomicity', () => {
  it('rejects a page PATCH that waited behind its workspace lock past grant expiry', async () => {
    const app = await createTestApp();
    await runExpiringGrantWriteBarrier({
      entityType: 'page',
      permission: 'edit',
      originalValue: 'Original page title',
      createEntity: (ownerId) => createTestPage(ownerId, { title: 'Original page title' }),
      request: (pageId, sessionCookie) =>
        app.request(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: sessionCookie,
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ title: 'Expired page title' }),
        }),
      readStoredValue: async (pageId) => {
        const result = await query<{ title: string }>('select title from pages where id = $1', [
          pageId,
        ]);
        return result.rows[0]?.title;
      },
    });
  });

  it('rejects a folder PATCH that waited behind its workspace lock past grant expiry', async () => {
    const app = await createTestApp();
    await runExpiringGrantWriteBarrier({
      entityType: 'folder',
      permission: 'admin',
      originalValue: 'Original folder name',
      createEntity: (ownerId) => createTestFolder(ownerId, { name: 'Original folder name' }),
      request: (folderId, sessionCookie) =>
        app.request(`/api/folders/${folderId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: sessionCookie,
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ name: 'Expired folder name' }),
        }),
      readStoredValue: async (folderId) => {
        const result = await query<{ name: string }>('select name from folders where id = $1', [
          folderId,
        ]);
        return result.rows[0]?.name;
      },
    });
  });
});
