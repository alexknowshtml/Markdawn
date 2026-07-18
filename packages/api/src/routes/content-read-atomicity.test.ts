import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor, query } from '../db/query';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';
import { lockWorkspaceAccessMutation } from '../utils/share-access';

async function waitForBlockedPid(blockerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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

async function runContentReadBarrier(options: {
  table: 'comments' | 'connections' | 'page_versions';
  request: (pageId: string, sessionCookie: string) => Response | Promise<Response>;
  insertSecret: (executor: QueryExecutor, pageId: string, ownerId: string) => Promise<void>;
}): Promise<{ response: Response; pageId: string; sessionCookie: string }> {
  const owner = await createTestUser();
  const viewer = await createTestUser();
  const page = await createTestPage(owner.id);
  const session = await createTestSession(viewer.id);
  await query(
    `insert into shares (
       entity_type, entity_id, shared_by, recipient_user_id, permission
     ) values ('page', $1, $2, $3, 'view')`,
    [page.id, owner.id, viewer.id],
  );

  let releaseTableLock = (): void => undefined;
  let reportBlockerPid = (_pid: number): void => undefined;
  const tableLockReleased = new Promise<void>((resolve) => {
    releaseTableLock = resolve;
  });
  const blockerReady = new Promise<number>((resolve) => {
    reportBlockerPid = resolve;
  });
  const tableBlocker = db.transaction(async (tx) => {
    await executeQuery(tx, `lock table ${options.table} in access exclusive mode`);
    const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
    const pid = pidResult.rows[0]?.pid;
    if (!pid) throw new Error('Failed to resolve content read blocker PID');
    reportBlockerPid(pid);
    await tableLockReleased;
  });

  const blockerPid = await blockerReady;
  const responsePromise = Promise.resolve(options.request(page.id, session.Cookie));
  const responsePid = await waitForBlockedPid(blockerPid);
  const mutationPromise = db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, owner.id);
    await executeQuery(
      tx,
      `delete from shares
       where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
      [page.id, viewer.id],
    );
    await options.insertSecret(tx, page.id, owner.id);
  });

  let orchestrationError: unknown = null;
  try {
    await waitForBlockedPid(responsePid);
  } catch (error) {
    orchestrationError = error;
  } finally {
    releaseTableLock();
    await tableBlocker;
  }
  const response = await responsePromise;
  await mutationPromise;
  if (orchestrationError) throw orchestrationError;
  return { response, pageId: page.id, sessionCookie: session.Cookie };
}

describe('access-controlled content read atomicity', () => {
  it('does not return comments created after the reader is revoked', async () => {
    const app = await createTestApp();
    const result = await runContentReadBarrier({
      table: 'comments',
      request: (pageId, sessionCookie) =>
        app.request(`/api/pages/${pageId}/comments`, {
          headers: { Cookie: sessionCookie },
        }),
      insertSecret: async (executor, pageId, ownerId) => {
        await executeQuery(
          executor,
          `insert into comments (page_id, user_id, content)
           values ($1, $2, 'post-revocation comment secret')`,
          [pageId, ownerId],
        );
      },
    });

    expect(result.response.status).toBe(200);
    expect(JSON.stringify(await result.response.json())).not.toContain(
      'post-revocation comment secret',
    );
    const afterRevoke = await app.request(`/api/pages/${result.pageId}/comments`, {
      headers: { Cookie: result.sessionCookie },
    });
    expect(afterRevoke.status).toBe(403);
  });

  it('does not return versions created after the reader is revoked', async () => {
    const app = await createTestApp();
    const result = await runContentReadBarrier({
      table: 'page_versions',
      request: (pageId, sessionCookie) =>
        app.request(`/api/pages/${pageId}/versions`, {
          headers: { Cookie: sessionCookie },
        }),
      insertSecret: async (executor, pageId, ownerId) => {
        await executeQuery(
          executor,
          `insert into page_versions (page_id, content, title, created_by)
           values ($1, '{}'::jsonb, 'post-revocation version secret', $2)`,
          [pageId, ownerId],
        );
      },
    });

    expect(result.response.status).toBe(200);
    expect(JSON.stringify(await result.response.json())).not.toContain(
      'post-revocation version secret',
    );
    const afterRevoke = await app.request(`/api/pages/${result.pageId}/versions`, {
      headers: { Cookie: result.sessionCookie },
    });
    expect(afterRevoke.status).toBe(403);
  });

  it('does not return outgoing link metadata created after the reader is revoked', async () => {
    const app = await createTestApp();
    const result = await runContentReadBarrier({
      table: 'connections',
      request: (pageId, sessionCookie) =>
        app.request(`/api/backlinks/outgoing?pageId=${pageId}`, {
          headers: { Cookie: sessionCookie },
        }),
      insertSecret: async (executor, pageId) => {
        await executeQuery(
          executor,
          `insert into connections (
             source_type, source_id, target_type, target_slug, target_label,
             connection_type, link_text
           ) values (
             'page', $1, 'page', 'post-revocation-secret',
             'post-revocation connection secret', 'wikilink',
             'post-revocation connection secret'
           )`,
          [pageId],
        );
      },
    });

    expect(result.response.status).toBe(200);
    expect(JSON.stringify(await result.response.json())).not.toContain(
      'post-revocation connection secret',
    );
    const afterRevoke = await app.request(`/api/backlinks/outgoing?pageId=${result.pageId}`, {
      headers: { Cookie: result.sessionCookie },
    });
    expect(afterRevoke.status).toBe(403);
  });
});
