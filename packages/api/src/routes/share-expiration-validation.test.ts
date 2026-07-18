import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';
import { lockWorkspaceAccessMutation } from '../utils/share-access';

async function waitForWorkspaceLockWaiter(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await query<{ count: string }>(
      `select count(*)::text as count
       from pg_stat_activity
       where $1 = any(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for invitation to reach the workspace lock');
}

describe('share invitation expiration validation', () => {
  it('rechecks expiration after waiting for the serialized access lock', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const session = await createTestSession(owner.id);
    const page = await createTestPage(owner.id);

    let releaseBlocker = (): void => undefined;
    let reportBlockerPid = (_pid: number): void => undefined;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<number>((resolve) => {
      reportBlockerPid = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockWorkspaceAccessMutation(tx, owner.id);
      const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
      const pid = pidResult.rows[0]?.pid;
      if (!pid) throw new Error('Failed to resolve invitation blocker PID');
      reportBlockerPid(pid);
      await blockerReleased;
    });

    const blockerPid = await blockerReady;
    const expiresAtMs = Date.now() + 1_500;
    const invitePromise = Promise.resolve(
      app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({
          email: recipient.email,
          permission: 'view',
          expiresAt: new Date(expiresAtMs).toISOString(),
        }),
      }),
    );

    let orchestrationError: unknown = null;
    try {
      await waitForWorkspaceLockWaiter(blockerPid);
      const remainingMs = expiresAtMs - Date.now() + 25;
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
    } catch (error) {
      orchestrationError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    if (orchestrationError) {
      await invitePromise;
      throw orchestrationError;
    }

    const inviteRes = await invitePromise;
    expect(inviteRes.status).toBe(400);
    expect(await inviteRes.json()).toMatchObject({ code: 'EXPIRATION_NOT_FUTURE' });
    const stored = await query(
      `select id from shares
       where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
      [page.id, recipient.id],
    );
    expect(stored.rowCount).toBe(0);
  });
});
