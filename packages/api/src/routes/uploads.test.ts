import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestPublicShare,
  createTestSession,
  createTestUser,
} from '../test-utils';
import { lockWorkspaceAccessMutation } from '../utils/share-access';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

type BlockedExpiryTransaction = {
  pid: number;
  expires_at: string;
  matching_advisory_lock: boolean;
  started_before_expiry: boolean;
};

async function waitForBlockedExpiryTransaction(
  blockerPid: number,
  entityId: string,
): Promise<BlockedExpiryTransaction> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await query<BlockedExpiryTransaction>(
      `select activity.pid,
              share.expires_at,
              activity.xact_start < share.expires_at as started_before_expiry,
              exists (
                select 1
                from pg_locks waiting
                join pg_locks held
                  on held.locktype = waiting.locktype
                 and held.database is not distinct from waiting.database
                 and held.classid is not distinct from waiting.classid
                 and held.objid is not distinct from waiting.objid
                 and held.objsubid is not distinct from waiting.objsubid
                where waiting.pid = activity.pid
                  and waiting.locktype = 'advisory'
                  and waiting.granted = false
                  and held.pid = $1
                  and held.granted = true
              ) as matching_advisory_lock
       from pg_stat_activity activity
       join shares share
         on share.entity_type = 'page'
        and share.entity_id = $2
        and share.token is not null
       where $1 = any(pg_blocking_pids(activity.pid))
         and activity.xact_start is not null
         and share.expires_at is not null
       order by activity.pid
       limit 1`,
      [blockerPid, entityId],
    );
    const row = result.rows[0];
    if (row?.matching_advisory_lock) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the upload request on the exact workspace access lock');
}

async function runUploadReadBarrier(
  request: () => Response | Promise<Response>,
  mutateAccess: () => Promise<void>,
): Promise<Response> {
  let releaseTableLock = (): void => undefined;
  let reportBlockerPid = (_pid: number): void => undefined;
  const tableLockReleased = new Promise<void>((resolve) => {
    releaseTableLock = resolve;
  });
  const blockerReady = new Promise<number>((resolve) => {
    reportBlockerPid = resolve;
  });
  const tableBlocker = db.transaction(async (tx) => {
    await executeQuery(tx, 'lock table shares in access exclusive mode');
    const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
    const pid = pidResult.rows[0]?.pid;
    if (!pid) throw new Error('Failed to resolve upload read blocker PID');
    reportBlockerPid(pid);
    await tableLockReleased;
  });

  const blockerPid = await blockerReady;
  const responsePromise = Promise.resolve(request());
  const responsePid = await waitForBlockedPid(blockerPid);
  const mutationPromise = mutateAccess();

  let orchestrationError: unknown = null;
  try {
    // The access mutation must wait on the upload request's workspace lock,
    // not pass the authorization check while byte materialization is paused.
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
  return response;
}

describe('uploads API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/uploads', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/uploads', () => {
    it('uploads an image file', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'test.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toMatch(/^\/api\/uploads\//);
    });

    it('rejects active content disguised as an image', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const formData = new FormData();
      formData.append(
        'file',
        new File(['<script>alert(1)</script>'], 'attack.png', { type: 'image/png' }),
      );
      formData.append('pageId', page.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for unsupported file type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const formData = new FormData();
      formData.append('file', new File(['text'], 'test.txt', { type: 'text/plain' }));
      formData.append('pageId', page.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when file is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: (() => {
          const formData = new FormData();
          formData.append('pageId', page.id);
          return formData;
        })(),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/uploads/:filename', () => {
    it('returns 400 for invalid filename characters', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/uploads/file@name.png', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent file', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/uploads/nonexistent.png', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns uploaded file bytes with correct Content-Type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const binaryData = PNG_BYTES;
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'real.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = await uploadRes.json();

      const res = await app.request(url, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      const returned = new Uint8Array(await res.arrayBuffer());
      expect(returned).toEqual(binaryData);
    });

    it('allows recipients to fetch uploads from directly shared root pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Shared Root Page' });

      const binaryData = PNG_BYTES;
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'shared-root.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const res = await app.request(url, {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
    });

    it('serializes authenticated byte reads before a concurrent revoke', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Atomic attachment read' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'atomic-private.png', { type: 'image/png' }));
      formData.append('pageId', page.id);
      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const response = await runUploadReadBarrier(
        () => app.request(url, { headers: { Cookie: recipientSession.Cookie } }),
        () =>
          db.transaction(async (tx) => {
            await lockWorkspaceAccessMutation(tx, owner.id);
            await executeQuery(
              tx,
              `DELETE FROM shares
               WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2`,
              [page.id, recipient.id],
            );
          }),
      );

      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
      const afterRevoke = await app.request(url, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(afterRevoke.status).toBe(403);
    });

    it('revokes an uploader from a referenced upload while preserving current page access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const uploader = await createTestUser();
      const currentRecipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const uploaderSession = await createTestSession(uploader.id);
      const currentRecipientSession = await createTestSession(currentRecipient.id);
      const page = await createTestPage(owner.id, { title: 'Attachment revocation' });

      const uploaderShare = await query<{ id: string }>(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')
         RETURNING id`,
        [page.id, owner.id, uploader.id],
      );
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, currentRecipient.id],
      );

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'revoked-uploader.png', { type: 'image/png' }));
      formData.append('pageId', page.id);
      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: uploaderSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };

      const beforeRevoke = await app.request(url, {
        headers: { Cookie: uploaderSession.Cookie },
      });
      expect(beforeRevoke.status).toBe(200);
      expect(beforeRevoke.headers.get('Cache-Control')).toBe('private, no-store');

      const shareId = uploaderShare.rows[0]?.id;
      if (!shareId) {
        throw new Error('Expected uploader share ID');
      }
      const revokeRes = await app.request(`/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(revokeRes.status).toBe(200);

      const [revokedUploaderRes, ownerRes, currentRecipientRes] = await Promise.all([
        app.request(url, { headers: { Cookie: uploaderSession.Cookie } }),
        app.request(url, { headers: { Cookie: ownerSession.Cookie } }),
        app.request(url, { headers: { Cookie: currentRecipientSession.Cookie } }),
      ]);
      expect(revokedUploaderRes.status).toBe(403);
      expect(revokedUploaderRes.headers.get('Cache-Control')).toBe('no-store');
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.headers.get('Cache-Control')).toBe('private, no-store');
      expect(currentRecipientRes.status).toBe(200);
      expect(currentRecipientRes.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('keeps the uploader fallback only after an upload has no page references', async () => {
      const app = await createTestApp();
      const uploader = await createTestUser();
      const otherUser = await createTestUser();
      const uploaderSession = await createTestSession(uploader.id);
      const otherSession = await createTestSession(otherUser.id);
      const page = await createTestPage(uploader.id, { title: 'Temporary upload page' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'orphan.png', { type: 'image/png' }));
      formData.append('pageId', page.id);
      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: uploaderSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };
      await query(
        `DELETE FROM upload_page_refs
         WHERE upload_id = (SELECT id FROM uploads WHERE filename = $1)`,
        [url.split('/').at(-1)],
      );

      const [uploaderRes, otherRes] = await Promise.all([
        app.request(url, { headers: { Cookie: uploaderSession.Cookie } }),
        app.request(url, { headers: { Cookie: otherSession.Cookie } }),
      ]);
      expect(uploaderRes.status).toBe(200);
      expect(otherRes.status).toBe(403);
    });

    it('blocks users who only have access to a different page by the upload owner', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const uploadPage = await createTestPage(owner.id, { title: 'Upload Page' });
      const sharedPage = await createTestPage(owner.id, { title: 'Other Shared Page' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'scoped.png', { type: 'image/png' }));
      formData.append('pageId', uploadPage.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [sharedPage.id, owner.id, recipient.id],
      );

      const res = await app.request(url, {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('blocks anonymous downloads for private page uploads', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Private Page' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'private.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };

      const res = await app.request(url);

      expect(res.status).toBe(404);
    });

    it('allows anonymous downloads for public page uploads', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Public Page' });

      const binaryData = PNG_BYTES;
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await createTestPublicShare(page.id);

      const res = await app.request(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(binaryData);
    });

    it('rechecks an expiring public link after waiting for the workspace access lock', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Expiring public attachment' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'expiring-public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);
      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };
      const publicShare = await createTestPublicShare(page.id);

      const blocker = new Client({ connectionString });
      let blockerTransactionOpen = false;
      let downloadPromise: Promise<Response> | null = null;
      await blocker.connect();

      try {
        await blocker.query('begin');
        blockerTransactionOpen = true;
        const blockerPidResult = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() as pid',
        );
        const blockerPid = blockerPidResult.rows[0]?.pid;
        if (blockerPid === undefined) {
          throw new Error('Could not resolve upload expiry blocker PID');
        }
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        const expiryResult = await query<{ expires_at: string }>(
          `update shares
           set expires_at = statement_timestamp() + interval '5 seconds'
           where entity_type = 'page' and entity_id = $1 and token = $2
           returning expires_at`,
          [page.id, publicShare.token],
        );
        const expiresAt = expiryResult.rows[0]?.expires_at;
        if (!expiresAt) throw new Error('Could not set upload link expiration');

        const pendingDownload = Promise.resolve(app.request(url));
        downloadPromise = pendingDownload;

        const blocked = await waitForBlockedExpiryTransaction(blockerPid, page.id);
        expect(blocked.matching_advisory_lock).toBe(true);
        expect(blocked.started_before_expiry).toBe(true);
        expect(blocked.expires_at).toBe(expiresAt);

        await blocker.query(
          `select pg_sleep(
             greatest(0, extract(epoch from ($1::timestamptz - statement_timestamp()))) + 0.05
           )`,
          [expiresAt],
        );
        const clockResult = await blocker.query<{ expired: boolean }>(
          'select statement_timestamp() > $1::timestamptz as expired',
          [expiresAt],
        );
        expect(clockResult.rows[0]?.expired).toBe(true);

        await blocker.query('commit');
        blockerTransactionOpen = false;

        const response = await pendingDownload;
        expect(response.status).toBe(404);
        expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(PNG_BYTES);
      } finally {
        if (blockerTransactionOpen) await blocker.query('rollback');
        await blocker.end();
        if (downloadPromise) await Promise.allSettled([downloadPromise]);
      }
    });

    it('serializes anonymous byte reads before a concurrent link disable', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Atomic public attachment read' });

      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'atomic-public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);
      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };
      await createTestPublicShare(page.id);

      const response = await runUploadReadBarrier(
        () => app.request(url),
        () =>
          db.transaction(async (tx) => {
            await lockWorkspaceAccessMutation(tx, owner.id);
            await executeQuery(
              tx,
              `DELETE FROM shares
               WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL`,
              [page.id],
            );
            await executeQuery(
              tx,
              `UPDATE pages
               SET is_public = false, public_token = null, updated_at = now()
               WHERE id = $1`,
              [page.id],
            );
          }),
      );

      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
      const afterDisable = await app.request(url);
      expect(afterDisable.status).toBe(404);
    });

    it('denies anonymous downloads after the page link expires', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);
      const formData = new FormData();
      formData.append('file', new File([PNG_BYTES], 'expired.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await createTestPublicShare(page.id);
      await query(
        `UPDATE shares SET expires_at = now() - interval '1 hour'
         WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL`,
        [page.id],
      );

      const res = await app.request(url);

      expect(res.status).toBe(404);
    });

    it('allows anonymous downloads for uploads in public folders', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      const binaryData = PNG_BYTES;
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'folder-public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      const token = crypto.randomUUID();
      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [folder.id, owner.id, token],
      );

      const res = await app.request(url);

      expect(res.status).toBe(200);
    });
  });
});
