import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { testQuery as query } from '../db/testQuery';
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

async function runRevocationBarrier(
  request: (pageId: string, sessionCookie: string) => Response | Promise<Response>,
): Promise<{
  response: Response;
  ownerId: string;
  revokedUserId: string;
  secretUserId: string;
  secretEmail: string;
  pageId: string;
  sessionCookie: string;
}> {
  const owner = await createTestUser();
  const revokedUser = await createTestUser();
  const secretUser = await createTestUser({ name: 'Post-revocation secret collaborator' });
  const page = await createTestPage(owner.id);
  const session = await createTestSession(revokedUser.id);
  await query(
    `insert into shares (
       entity_type, entity_id, shared_by, recipient_user_id, permission
     ) values ('page', $1, $2, $3, 'admin')`,
    [page.id, owner.id, revokedUser.id],
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
    await executeQuery(tx, sql.raw('lock table shares in access exclusive mode'));
    const pidResult = await executeQuery<{ pid: number }>(
      tx,
      sql.raw('select pg_backend_pid() as pid'),
    );
    const pid = pidResult.rows[0]?.pid;
    if (!pid) throw new Error('Failed to resolve sharing read blocker PID');
    reportBlockerPid(pid);
    await tableLockReleased;
  });

  const blockerPid = await blockerReady;
  const responsePromise = Promise.resolve(request(page.id, session.Cookie));
  const responsePid = await waitForBlockedPid(blockerPid);
  const mutationPromise = db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, owner.id);
    await executeQuery(
      tx,
      sql`delete from shares
       where entity_type = 'page' and entity_id = ${page.id} and recipient_user_id = ${revokedUser.id}`,
    );
    await executeQuery(
      tx,
      sql`insert into shares (
         entity_type, entity_id, shared_by, recipient_user_id, permission
       ) values ('page', ${page.id}, ${owner.id}, ${secretUser.id}, 'view')`,
    );
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

  return {
    response,
    ownerId: owner.id,
    revokedUserId: revokedUser.id,
    secretUserId: secretUser.id,
    secretEmail: secretUser.email,
    pageId: page.id,
    sessionCookie: session.Cookie,
  };
}

describe('sharing management read atomicity', () => {
  it('does not mix a pre-revoke summary authorization with post-revoke grant data', async () => {
    const app = await createTestApp();
    const result = await runRevocationBarrier((pageId, sessionCookie) =>
      app.request(`/api/shares/entity/page/${pageId}`, {
        headers: { Cookie: sessionCookie },
      }),
    );

    expect(result.response.status).toBe(200);
    const summary = (await result.response.json()) as {
      visibility: string;
      grants: Array<{ recipientUserId: string | null }>;
    };
    expect(summary.visibility).toBe('full');
    expect(summary.grants).not.toContainEqual(
      expect.objectContaining({ recipientUserId: result.secretUserId }),
    );
    expect(JSON.stringify(summary)).not.toContain(result.secretEmail);

    const afterRevoke = await app.request(`/api/shares/entity/page/${result.pageId}`, {
      headers: { Cookie: result.sessionCookie },
    });
    expect(afterRevoke.status).toBe(403);
  });

  it('does not mix collaborator authorization with post-revoke identities', async () => {
    const app = await createTestApp();
    const result = await runRevocationBarrier((pageId, sessionCookie) =>
      app.request(`/api/shares/pages/collaborators?ids=${pageId}`, {
        headers: { Cookie: sessionCookie },
      }),
    );

    expect(result.response.status).toBe(200);
    const collaborators = (await result.response.json()) as Record<
      string,
      Array<{ userId?: string; email?: string }>
    >;
    expect(collaborators[result.pageId]).not.toContainEqual(
      expect.objectContaining({ userId: result.secretUserId }),
    );
    expect(JSON.stringify(collaborators)).not.toContain(result.secretEmail);

    const afterRevoke = await app.request(`/api/shares/pages/collaborators?ids=${result.pageId}`, {
      headers: { Cookie: result.sessionCookie },
    });
    expect(afterRevoke.status).toBe(200);
    expect(await afterRevoke.json()).toEqual({ [result.pageId]: [] });
  });
});
