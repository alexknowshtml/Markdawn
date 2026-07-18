import { MAX_PAGE_TITLE_LENGTH } from '@markdawn/shared';
import { extractConnectionsFromYDoc } from '@markdawn/shared/yjs-helpers';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';
import { lockWorkspaceAccessMutation } from '../utils/share-access';

async function readWorkspaceAccessVersion(workspaceOwnerId: string): Promise<string> {
  const result = await query<{ version: string }>(
    `select coalesce((
       select version::text from workspace_access_versions where workspace_owner_id = $1
     ), '0') as version`,
    [workspaceOwnerId],
  );
  return result.rows[0]?.version ?? '0';
}

async function waitForWorkspaceLockWaiter(blockerPid: number, minimumCount = 1): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await query<{ count: string }>(
      `select count(*)::text as count
       from pg_stat_activity
       where $1 = any(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (Number(result.rows[0]?.count ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for page restore to reach the workspace lock');
}

const PRIVATE_PAGE_DETAIL_FIELDS = [
  'parentId',
  'parent_id',
  'createdBy',
  'created_by',
  'ownerId',
  'owner_id',
  'publicToken',
  'public_token',
  'isDeleted',
  'is_deleted',
  'deletedAt',
  'deleted_at',
  'inheritancePolicy',
  'inheritance_policy',
  'ydoc',
] as const;

function expectFieldsAbsent(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    expect(Object.hasOwn(value, field), `expected ${field} to be absent`).toBe(false);
  }
}

async function waitForBlockedPid(blockerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  throw new Error('Timed out waiting for the public-link visit to block');
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
  throw new Error('Timed out waiting for the page request on the exact workspace access lock');
}

async function waitForVisitDisableOrdering(
  visitorPid: number,
  pageId: string,
): Promise<'disable-finished-first' | 'disable-waits-for-visit'> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await query<{ is_public: boolean; disable_waiters: string }>(
      `select p.is_public,
              (select count(*)::text
               from pg_stat_activity
               where $1 = any(pg_blocking_pids(pid))) as disable_waiters
       from pages p
       where p.id = $2`,
      [visitorPid, pageId],
    );
    const row = result.rows[0];
    if (row?.is_public === false) return 'disable-finished-first';
    if (Number(row?.disable_waiters ?? 0) >= 1) return 'disable-waits-for-visit';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for public-link disable ordering');
}

type ShareEventNotification = {
  type: 'share_event';
  action: string;
  entityType: 'page' | 'folder';
  entityId: string;
  targetUserId?: string;
  metaUserIds?: string[];
  metaOnly?: boolean;
};

async function flushShareEventNotifications(payloads: string[]): Promise<ShareEventNotification[]> {
  const marker = `test-notification-marker:${crypto.randomUUID()}`;
  await query("select pg_notify('share_event', $1)", [marker]);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const markerIndex = payloads.indexOf(marker);
    if (markerIndex >= 0) {
      const batch = payloads.splice(0, markerIndex + 1).slice(0, -1);
      return batch.flatMap((payload) => {
        try {
          const parsed = JSON.parse(payload) as Partial<ShareEventNotification>;
          return parsed.type === 'share_event' && parsed.entityId
            ? [parsed as ShareEventNotification]
            : [];
        } catch {
          return [];
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out flushing share event notifications');
}

async function addFolderShare(folderId: string, recipientUserId: string, permission = 'view') {
  await query(
    `INSERT INTO shares (entity_type, entity_id, recipient_user_id, permission, token)
     VALUES ('folder', $1, $2, $3, NULL)`,
    [folderId, recipientUserId, permission],
  );
}

describe('pages API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/tree');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/pages', () => {
    it('creates a page with valid data', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          title: 'My Test Page',
        }),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body.title).toBe('My Test Page');
      expect(body.id).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      expect(body.updatedAt).toBeTruthy();
    });

    it('rejects a title that the collaboration server would refuse', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'x'.repeat(MAX_PAGE_TITLE_LENGTH + 1) }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        message: `Title must be ${MAX_PAGE_TITLE_LENGTH} characters or fewer`,
      });
      const stored = await query<{ count: string }>(
        'select count(*)::text as count from pages where created_by = $1',
        [user.id],
      );
      expect(stored.rows[0]?.count).toBe('0');
    });

    it('accepts 250 astral characters and rejects the 251st', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const boundaryTitle = '📚'.repeat(MAX_PAGE_TITLE_LENGTH);

      const accepted = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: boundaryTitle }),
      });
      expect(accepted.status).toBe(201);
      expect((await accepted.json()) as { title: string }).toMatchObject({ title: boundaryTitle });

      const rejected = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: `${boundaryTitle}📚` }),
      });
      expect(rejected.status).toBe(400);
    });

    it('rejects oversized creation bodies before parsing them', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'x'.repeat(70 * 1024) }),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ message: 'Request body is too large' });
    });

    it('creates after a sibling with a position beyond JavaScript safe numeric formatting', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const existing = await createTestPage(user.id);
      await query('update pages set position = $1 where id = $2', [
        '1000000000000000000000',
        existing.id,
      ]);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'After large position' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.position).toBe('1000000000000000000001');
    });

    it('returns 404 for non-existent parentId', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          title: 'Orphan Page',
          parentId: '00000000-0000-0000-0000-000000000000',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('requires admin access to create inside a shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const folder = await createTestFolder(owner.id);
      await addFolderShare(folder.id, editor.id, 'edit');

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'Not allowed', parentId: folder.id }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/pages/tree', () => {
    it('returns pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      await createTestPage(user.id, { title: 'Page 1' });
      await createTestPage(user.id, { title: 'Page 2' });

      const res = await app.request(`/api/pages/tree`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body.map((p: { title: string }) => p.title).sort()).toEqual(['Page 1', 'Page 2']);
      expect(body[0]).toHaveProperty('id');
    });

    it("includes root workspace owner's pages for workspace members", async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const session = await createTestSession(member.id);
      const page = await createTestPage(owner.id, { title: 'Workspace Root Page' });
      await createTestWorkspaceMember(owner.id, member.id, 'viewer');

      const res = await app.request('/api/pages/tree', {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const workspacePage = body.find((p: { id: string }) => p.id === page.id);
      expect(workspacePage).toMatchObject({ workspaceAccess: true, userPermission: 'view' });
    });

    it('includes pages under directly shared folders for folder share recipients', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Page in Shared Folder',
        parentId: folder.id,
      });
      await addFolderShare(folder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('includes pages under inherited shared folders for folder share recipients', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const parentFolder = await createTestFolder(owner.id, { name: 'Shared Parent' });
      const childFolder = await createTestFolder(owner.id, {
        name: 'Shared Child',
        parentId: parentFolder.id,
      });
      const page = await createTestPage(owner.id, {
        title: 'Page Under Shared Ancestor',
        parentId: childFolder.id,
      });
      await addFolderShare(parentFolder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('still includes pages directly in a non-restricted shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Page in Shared Folder',
        parentId: folder.id,
      });
      await addFolderShare(folder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });
  });

  describe('GET /api/pages/trash', () => {
    it('lists trashed pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'To Delete' });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/trash', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('uses folder owner, not creator, for child page trash control', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const collaboratorSession = await createTestSession(collaborator.id);
      const folder = await createTestFolder(owner.id, { name: 'Owner Folder' });
      const page = await createTestPage(collaborator.id, {
        title: 'Collaborator Child',
        parentId: folder.id,
      });

      const deleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(deleteRes.status).toBe(200);

      const ownerTrashRes = await app.request('/api/pages/trash', {
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(ownerTrashRes.status).toBe(200);
      const ownerTrash = (await ownerTrashRes.json()) as Array<{
        id: string;
        ownerId: string | null;
      }>;
      expect(ownerTrash).toContainEqual(
        expect.objectContaining({ id: page.id, ownerId: owner.id }),
      );

      const collaboratorTrashRes = await app.request('/api/pages/trash', {
        headers: { Cookie: collaboratorSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(collaboratorTrashRes.status).toBe(200);
      const collaboratorTrash = (await collaboratorTrashRes.json()) as Array<{ id: string }>;
      expect(collaboratorTrash).not.toContainEqual(expect.objectContaining({ id: page.id }));

      const collaboratorRestoreRes = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: collaboratorSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(collaboratorRestoreRes.status).toBe(403);

      const ownerRestoreRes = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(ownerRestoreRes.status).toBe(200);

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      const permanentRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(permanentRes.status).toBe(200);

      const pageRows = await query('select id from pages where id = $1', [page.id]);
      expect(pageRows.rowCount).toBe(0);
    });

    it('rechecks ownership after a concurrent parent workspace change', async () => {
      const app = await createTestApp();
      const originalOwner = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(originalOwner.id);
      const originalRoot = await createTestFolder(originalOwner.id, { name: 'Original root' });
      const otherRoot = await createTestFolder(otherOwner.id, { name: 'Other root' });
      const page = await createTestPage(originalOwner.id, {
        title: 'Deleted child',
        parentId: originalRoot.id,
      });
      const deleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(deleteRes.status).toBe(200);

      let releaseBlocker = (): void => undefined;
      let reportBlockerPid = (_pid: number): void => undefined;
      const blockerReleased = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const blockerReady = new Promise<number>((resolve) => {
        reportBlockerPid = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await lockWorkspaceAccessMutation(tx, originalOwner.id);
        const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
        const pid = pidResult.rows[0]?.pid;
        if (!pid) throw new Error('Failed to resolve page restore blocker PID');
        reportBlockerPid(pid);
        await blockerReleased;
      });

      const blockerPid = await blockerReady;
      const restorePromise = app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie },
      });
      let orchestrationError: unknown = null;
      try {
        await waitForWorkspaceLockWaiter(blockerPid);
        await query('update folders set parent_id = $1 where id = $2', [
          otherRoot.id,
          originalRoot.id,
        ]);
      } catch (error) {
        orchestrationError = error;
      } finally {
        releaseBlocker();
        await blocker;
      }
      const restoreRes = await restorePromise;
      if (orchestrationError) throw orchestrationError;

      expect(restoreRes.status).toBe(403);
      expect(await restoreRes.json()).toMatchObject({
        message: 'You can only restore pages that you own',
      });
      const stored = await query<{ is_deleted: boolean }>(
        'select is_deleted from pages where id = $1',
        [page.id],
      );
      expect(stored.rows[0]?.is_deleted).toBe(true);
    });
  });

  describe('DELETE /api/pages/trash/empty-all', () => {
    it('empties all trashed pages', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/trash/empty-all', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
      expect(body.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/pages/:id/access', () => {
    it('preserves public-link navigation when a stronger account grant is revoked', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Public fallback' });
      const token = crypto.randomUUID();
      const invite = await query<{ id: string }>(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit') returning id`,
        [page.id, owner.id, recipient.id],
      );
      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        token,
        page.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, token],
      );

      const accessRes = await app.request(`/api/pages/${page.id}/access`, {
        method: 'POST',
        headers: { Cookie: recipientSession.Cookie, 'x-share-token': token },
      });
      expect(accessRes.status).toBe(200);
      expect(await accessRes.json()).toMatchObject({
        recordedLinkAccess: true,
        linkAccessSource: 'page',
      });

      const revokeRes = await app.request(`/api/shares/${invite.rows[0]?.id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(revokeRes.status).toBe(200);

      const withMeRes = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(withMeRes.status).toBe(200);
      const items = (await withMeRes.json()) as Array<{
        entityId: string;
        entityType: string;
        source: string;
      }>;
      expect(items).toContainEqual(
        expect.objectContaining({ entityType: 'page', entityId: page.id, source: 'link' }),
      );
    });

    it('records only page-scoped public provenance and notifies on first sight', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const visitor = await createTestUser();
      const visitorSession = await createTestSession(visitor.id);
      const root = await createTestFolder(owner.id, { name: 'Public root' });
      const nested = await createTestFolder(owner.id, {
        name: 'Public nested',
        parentId: root.id,
      });
      const page = await createTestPage(owner.id, {
        parentId: nested.id,
        title: 'All public fallbacks',
      });
      const rootToken = crypto.randomUUID();
      const nestedToken = crypto.randomUUID();
      const pageToken = crypto.randomUUID();

      await query(
        `update folders
         set is_public = true,
             public_token = case id when $1 then $2 else $3 end
         where id = any($4::uuid[])`,
        [root.id, rootToken, nestedToken, [root.id, nested.id]],
      );
      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        pageToken,
        page.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values
           ('folder', $1, $4, 'view', $2),
           ('folder', $3, $4, 'edit', $5),
           ('page', $6, $4, 'view', $7)`,
        [root.id, rootToken, nested.id, owner.id, nestedToken, page.id, pageToken],
      );
      const revisionBefore = await query<{ version: string }>(
        `select coalesce((
           select version::text from workspace_access_versions where workspace_owner_id = $1
         ), '0') as version`,
        [owner.id],
      );

      const listener = new Client({ connectionString });
      const payloads: string[] = [];
      listener.on('notification', (notification) => {
        if (notification.channel === 'share_event' && notification.payload) {
          payloads.push(notification.payload);
        }
      });
      await listener.connect();
      await listener.query('listen share_event');

      try {
        const firstVisit = await app.request(`/api/pages/${page.id}/access`, {
          method: 'POST',
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': pageToken },
        });
        expect(firstVisit.status).toBe(200);
        expect(await firstVisit.json()).toMatchObject({
          recordedLinkAccess: true,
          linkAccessSource: 'page',
        });

        const pageEvents = await query<{ token: string }>(
          `select token from page_access_events
           where page_id = $1 and user_id = $2 and source = 'link'`,
          [page.id, visitor.id],
        );
        expect(pageEvents.rows.map((row) => row.token)).toEqual([pageToken]);

        const folderEvents = await query<{ folder_id: string; token: string }>(
          `select folder_id, token from folder_access_events
           where user_id = $1 and folder_id = any($2::uuid[])
           order by folder_id`,
          [visitor.id, [root.id, nested.id]],
        );
        expect(folderEvents.rows).toEqual([]);

        const firstNotifications = (await flushShareEventNotifications(payloads)).filter(
          (payload) => payload.targetUserId === visitor.id,
        );
        expect(firstNotifications).toEqual([
          expect.objectContaining({
            action: 'recompute',
            entityType: 'page',
            entityId: page.id,
            targetUserId: visitor.id,
            metaUserIds: [visitor.id],
            metaOnly: true,
          }),
        ]);

        const repeatVisit = await app.request(`/api/pages/${page.id}/access`, {
          method: 'POST',
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': pageToken },
        });
        expect(repeatVisit.status).toBe(200);
        const repeatNotifications = (await flushShareEventNotifications(payloads)).filter(
          (payload) => payload.targetUserId === visitor.id,
        );
        expect(repeatNotifications).toEqual([]);
        const revisionAfter = await query<{ version: string }>(
          `select coalesce((
             select version::text from workspace_access_versions where workspace_owner_id = $1
           ), '0') as version`,
          [owner.id],
        );
        expect(revisionAfter.rows[0]?.version).toBe(revisionBefore.rows[0]?.version);
      } finally {
        await listener.end();
      }
    });

    it('serializes a link visit before disable so stale provenance cannot reappear', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const visitor = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const visitorSession = await createTestSession(visitor.id);
      const page = await createTestPage(owner.id, { title: 'Visit disable race' });
      const token = crypto.randomUUID();
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const functionName = `block_page_link_visit_${suffix}`;
      const triggerName = `block_page_link_visit_trigger_${suffix}`;
      const lockKey = `test-page-link-visit:${token}`;

      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        token,
        page.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, token],
      );
      await query(
        `create function ${functionName}() returns trigger language plpgsql as $$
         begin
           if new.token = '${token}' then
             perform pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
           end if;
           return new;
         end
         $$`,
      );
      await query(
        `create trigger ${triggerName}
         before insert on page_access_events
         for each row execute function ${functionName}()`,
      );

      const blocker = new Client({ connectionString });
      let blockerTransactionOpen = false;
      let accessPromise: Promise<Response> | null = null;
      let disablePromise: Promise<Response> | null = null;
      await blocker.connect();

      try {
        await blocker.query('begin');
        blockerTransactionOpen = true;
        const blockerPidResult = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() as pid',
        );
        const blockerPid = blockerPidResult.rows[0]?.pid;
        if (blockerPid === undefined) throw new Error('Could not resolve blocker PID');
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

        const pendingAccess = Promise.resolve(
          app.request(`/api/pages/${page.id}/access`, {
            method: 'POST',
            headers: { Cookie: visitorSession.Cookie, 'x-share-token': token },
          }),
        );
        accessPromise = pendingAccess;
        const visitorPid = await waitForBlockedPid(blockerPid);

        const pendingDisable = Promise.resolve(
          app.request(`/api/shares/entity/page/${page.id}/link`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
            body: JSON.stringify({ permission: 'private' }),
          }),
        );
        disablePromise = pendingDisable;
        expect(await waitForVisitDisableOrdering(visitorPid, page.id)).toBe(
          'disable-waits-for-visit',
        );

        await blocker.query('rollback');
        blockerTransactionOpen = false;
        const [accessResponse, disableResponse] = await Promise.all([
          pendingAccess,
          pendingDisable,
        ]);
        expect(accessResponse.status).toBe(200);
        expect(disableResponse.status).toBe(200);

        const staleEvents = await query<{ count: string }>(
          `select count(*)::text as count
           from page_access_events
           where page_id = $1 and user_id = $2 and token = $3`,
          [page.id, visitor.id, token],
        );
        expect(staleEvents.rows[0]?.count).toBe('0');
      } finally {
        if (blockerTransactionOpen) {
          await blocker.query('rollback').catch(() => undefined);
        }
        if (accessPromise) await accessPromise.catch(() => undefined);
        if (disablePromise) await disablePromise.catch(() => undefined);
        await blocker.end();
        await query(`drop trigger if exists ${triggerName} on page_access_events`);
        await query(`drop function if exists ${functionName}()`);
      }
    });
  });

  describe('GET /api/pages/export', () => {
    it('exports accessible pages from the mounted route', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestPage(user.id, { title: 'Exported Page' });

      const res = await app.request('/api/pages/export', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/zip');
      expect(res.headers.get('Content-Disposition')).toContain('markdawn-export.zip');
    });
  });

  describe('GET /api/pages/recent', () => {
    it('returns recent pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/recent', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 400 for non-positive limit', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/recent?limit=0', {
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/pages/:id public access', () => {
    it('allows anonymous access to a page through a public ancestor folder link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, {
        parentId: folder.id,
        title: 'Inherited Public Page',
      });
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

      expect((await app.request(`/api/pages/${page.id}`)).status).toBe(404);
      expect((await app.request(`/api/pages/${page.id}?share=${crypto.randomUUID()}`)).status).toBe(
        404,
      );

      const res = await app.request(`/api/pages/${page.id}?share=${token}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Inherited Public Page');
      expect(body.isPublic).toBe(true);
      expect(body.linkPermission).toBe('view');
      expectFieldsAbsent(body as Record<string, unknown>, PRIVATE_PAGE_DETAIL_FIELDS);
    });

    it('returns the minimal DTO to a signed-in link-only visitor without bumping revisions', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const visitor = await createTestUser();
      const visitorSession = await createTestSession(visitor.id);
      const page = await createTestPage(owner.id, { title: 'Signed link-only page' });
      const token = crypto.randomUUID();
      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        token,
        page.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, token],
      );
      const readVersion = async (): Promise<string> => {
        const version = await query<{ version: string }>(
          `select coalesce((
             select version::text from workspace_access_versions where workspace_owner_id = $1
           ), '0') as version`,
          [owner.id],
        );
        return version.rows[0]?.version ?? '0';
      };
      const before = await readVersion();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.request(`/api/pages/${page.id}`, {
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': token },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ id: page.id, title: 'Signed link-only page' });
        expectFieldsAbsent(body, PRIVATE_PAGE_DETAIL_FIELDS);
      }
      expect(await readVersion()).toBe(before);
    });

    it('returns an explicit authenticated DTO to an account-source viewer', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const viewerSession = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Account-source page' });
      const token = crypto.randomUUID();
      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        token,
        page.id,
      ]);
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission, token
         ) values
           ('page', $1, $2, $3, 'view', null),
           ('page', $1, $2, null, 'edit', $4)`,
        [page.id, owner.id, viewer.id, token],
      );

      const response = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: viewerSession.Cookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: page.id,
        createdBy: owner.id,
        ownerId: owner.id,
        userPermission: 'edit',
      });
      expectFieldsAbsent(body, [
        'created_by',
        'owner_id',
        'publicToken',
        'public_token',
        'isDeleted',
        'is_deleted',
        'deletedAt',
        'deleted_at',
        'ydoc',
      ]);
    });
  });

  describe('PATCH /api/pages/:id/title public access', () => {
    it('renames a page through an anonymous edit link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id, { title: 'Original title' });
      const token = crypto.randomUUID();
      await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'edit', $3)`,
        [page.id, owner.id, token],
      );
      const revisionBefore = await readWorkspaceAccessVersion(owner.id);

      expect(
        (
          await app.request(`/api/pages/${page.id}/title`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Missing token' }),
          })
        ).status,
      ).toBe(404);

      const res = await app.request(`/api/pages/${page.id}/title?share=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Anonymous title' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ title: 'Anonymous title' });
      const stored = await query<{ title: string }>('select title from pages where id = $1', [
        page.id,
      ]);
      expect(stored.rows[0]?.title).toBe('Anonymous title');
      expect(await readWorkspaceAccessVersion(owner.id)).toBe(revisionBefore);
    });

    it('rechecks an expiring edit link after waiting for the workspace access lock', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id, { title: 'Before expiry' });
      const token = crypto.randomUUID();
      await query('update pages set is_public = true, public_token = $1 where id = $2', [
        token,
        page.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('page', $1, $2, 'edit', $3)`,
        [page.id, owner.id, token],
      );

      const blocker = new Client({ connectionString });
      let blockerTransactionOpen = false;
      let titlePromise: Promise<Response> | null = null;
      await blocker.connect();

      try {
        await blocker.query('begin');
        blockerTransactionOpen = true;
        const blockerPidResult = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() as pid',
        );
        const blockerPid = blockerPidResult.rows[0]?.pid;
        if (blockerPid === undefined) throw new Error('Could not resolve page expiry blocker PID');
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        const expiryResult = await query<{ expires_at: string }>(
          `update shares
           set expires_at = statement_timestamp() + interval '5 seconds'
           where entity_type = 'page' and entity_id = $1 and token = $2
           returning expires_at`,
          [page.id, token],
        );
        const expiresAt = expiryResult.rows[0]?.expires_at;
        if (!expiresAt) throw new Error('Could not set page link expiration');

        const pendingTitle = Promise.resolve(
          app.request(`/api/pages/${page.id}/title`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-share-token': token },
            body: JSON.stringify({ title: 'Must not persist' }),
          }),
        );
        titlePromise = pendingTitle;

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

        const response = await pendingTitle;
        expect(response.status).toBe(404);
        const stored = await query<{ title: string }>('select title from pages where id = $1', [
          page.id,
        ]);
        expect(stored.rows[0]?.title).toBe('Before expiry');
      } finally {
        if (blockerTransactionOpen) await blocker.query('rollback');
        await blocker.end();
        if (titlePromise) await Promise.allSettled([titlePromise]);
      }
    });

    it('rejects title changes through a view-only link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      const token = crypto.randomUUID();
      await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, token],
      );

      const res = await app.request(`/api/pages/${page.id}/title?share=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Not allowed' }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ message: 'Forbidden' });
    });

    it('rejects oversized public request bodies before parsing JSON', async () => {
      const app = await createTestApp();

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/title', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'T'.repeat(5_000) }),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ message: 'Request body is too large' });
    });

    it('rejects oversized titles through an anonymous edit link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      const token = crypto.randomUUID();
      await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'edit', $3)`,
        [page.id, owner.id, token],
      );

      const res = await app.request(`/api/pages/${page.id}/title?share=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'T'.repeat(251) }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'Title must be 250 characters or fewer' });
    });

    it('does not reveal private pages through the public title endpoint', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/pages/${page.id}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Not allowed' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/pages/:id/restore', () => {
    it('restores a soft-deleted page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const _body = await res.json();
      const treeRes = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const tree = await treeRes.json();
      expect(tree.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('preserves an active parent and the original creator', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const creator = await createTestUser();
      const session = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(creator.id, { parentId: folder.id });

      const deleteResponse = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(deleteResponse.status).toBe(200);

      const restoreResponse = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(restoreResponse.status).toBe(200);

      const restored = await query<{
        parent_id: string | null;
        created_by: string | null;
        is_deleted: boolean;
      }>('SELECT parent_id, created_by, is_deleted FROM pages WHERE id = $1', [page.id]);
      expect(restored.rows[0]).toEqual({
        parent_id: folder.id,
        created_by: creator.id,
        is_deleted: false,
      });
    });

    it('restores a page from a deleted folder to the workspace root', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const session = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(collaborator.id, { parentId: folder.id });

      const deleteResponse = await app.request(`/api/folders/${folder.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(deleteResponse.status).toBe(200);

      const restoreResponse = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(restoreResponse.status).toBe(200);
      const restored = await query<{
        parent_id: string | null;
        created_by: string;
        is_deleted: boolean;
      }>('SELECT parent_id, created_by, is_deleted FROM pages WHERE id = $1', [page.id]);
      expect(restored.rows[0]).toEqual({
        parent_id: null,
        created_by: owner.id,
        is_deleted: false,
      });
      const deletedFolder = await query<{ is_deleted: boolean }>(
        'SELECT is_deleted FROM folders WHERE id = $1',
        [folder.id],
      );
      expect(deletedFolder.rows[0]?.is_deleted).toBe(true);
    });
  });

  describe('PATCH /api/pages/:id/move', () => {
    it('moves a page to a different parent', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Movable' });

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: null, position: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(page.id);
    });

    it('rejects a non-numeric move position without changing the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'a0' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
      const stored = await query<{ position: string }>('SELECT position FROM pages WHERE id = $1', [
        page.id,
      ]);
      expect(stored.rows[0]?.position).toBe('0');
    });

    it('keeps position-only moves revision-neutral and advances revisions for parent changes', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const destination = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id);
      const revisionBefore = await readWorkspaceAccessVersion(owner.id);

      const reorder = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: '42' }),
      });
      expect(reorder.status).toBe(200);
      expect(await readWorkspaceAccessVersion(owner.id)).toBe(revisionBefore);

      const move = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destination.id, position: '0' }),
      });
      expect(move.status).toBe(200);
      expect(BigInt(await readWorkspaceAccessVersion(owner.id))).toBeGreaterThan(
        BigInt(revisionBefore),
      );
    });

    it('rejects decimal positions that exceed the database precision bound', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const oversizedPosition = `0.${'0'.repeat(128)}1`;

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: oversizedPosition }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('prevents moving page to itself', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: page.id }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects moving a shared page into a folder the caller cannot edit', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(collaborator.id);
      const page = await createTestPage(owner.id);
      const forbiddenFolder = await createTestFolder(otherOwner.id);

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, collaborator.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: forbiddenFolder.id }),
      });

      expect(res.status).toBe(403);
    });

    it('does not let editors move pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const sourceFolder = await createTestFolder(owner.id);
      const destinationFolder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'edit'), ('folder', $4, $3, $2, 'edit')`,
        [sourceFolder.id, editor.id, owner.id, destinationFolder.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(403);
    });

    it('lets admins move pages between folders owned by the same user', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const session = await createTestSession(admin.id);
      const sourceFolder = await createTestFolder(owner.id);
      const destinationFolder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'admin'), ('folder', $4, $3, $2, 'admin')`,
        [sourceFolder.id, admin.id, owner.id, destinationFolder.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(200);
    });

    it('blocks moves between different owners even when the caller is admin in both places', async () => {
      const app = await createTestApp();
      const sourceOwner = await createTestUser();
      const destinationOwner = await createTestUser();
      const admin = await createTestUser();
      const session = await createTestSession(admin.id);
      const sourceFolder = await createTestFolder(sourceOwner.id);
      const destinationFolder = await createTestFolder(destinationOwner.id);
      const page = await createTestPage(sourceOwner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'admin'), ('folder', $4, $5, $2, 'admin')`,
        [sourceFolder.id, admin.id, sourceOwner.id, destinationFolder.id, destinationOwner.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/pages/:id/export/markdown', () => {
    it('exports page content as markdown', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const page = await createTestPage(user.id, { title: 'Export' });

      const res = await app.request(`/api/pages/${page.id}/export/markdown`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('export.md');
      const body = await res.text();
      expect(typeof body).toBe('string');
    });

    it('allows signed-in viewers to export a shared page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Shared Export' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/pages/${page.id}/export/markdown`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
    });

    it('orders a queued revoke before a later export authorization snapshot', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const viewerSession = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Revoke export race' });
      const share = await query<{ id: string }>(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')
         returning id`,
        [page.id, owner.id, viewer.id],
      );
      const shareId = share.rows[0]?.id;
      if (!shareId) throw new Error('Failed to create test share');

      let releaseBlocker = (): void => undefined;
      const blockerRelease = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      let signalBlockerReady = (_pid: number): void => undefined;
      const blockerReady = new Promise<number>((resolve) => {
        signalBlockerReady = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await lockWorkspaceAccessMutation(tx, owner.id);
        const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
        const pid = pidResult.rows[0]?.pid;
        if (pid === undefined) throw new Error('Failed to resolve blocker PID');
        signalBlockerReady(pid);
        await blockerRelease;
      });
      const blockerPid = await blockerReady;
      const revokePromise = app.request(`/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      let exportPromise: Promise<Response> | null = null;

      try {
        await waitForWorkspaceLockWaiter(blockerPid);
        const queuedExport = Promise.resolve(
          app.request(`/api/pages/${page.id}/export/markdown`, {
            headers: { Cookie: viewerSession.Cookie },
          }),
        );
        exportPromise = queuedExport;
        await waitForWorkspaceLockWaiter(blockerPid, 2);
        releaseBlocker();

        const revokeResponse = await revokePromise;
        const exportResponse = await queuedExport;
        expect(revokeResponse.status).toBe(200);
        expect(exportResponse.status).toBe(403);
      } finally {
        releaseBlocker();
        await blocker;
        await Promise.allSettled([revokePromise, ...(exportPromise ? [exportPromise] : [])]);
      }
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(
        '/api/pages/00000000-0000-0000-0000-000000000000/export/markdown',
        {
          headers: { Cookie: session.Cookie },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pages/:id/import/markdown', () => {
    it('imports markdown via JSON body', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Import' });
      const revisionBefore = await readWorkspaceAccessVersion(user.id);

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ markdown: '# New Content\n\nHello world' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(await readWorkspaceAccessVersion(user.id)).toBe(revisionBefore);
    });

    it('does not embed any workspace page IDs for an edit-link importer', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const importer = await createTestUser();
      const session = await createTestSession(importer.id);
      const destination = await createTestPage(owner.id, { title: 'Public import target' });
      const visibleTarget = await createTestPage(owner.id, { title: 'Visible reference' });
      const hiddenTarget = await createTestPage(owner.id, { title: 'Private reference' });
      const hiddenDuplicate = await createTestPage(owner.id, { title: 'Visible reference' });
      const token = crypto.randomUUID();

      await query(`update pages set is_public = true, public_token = $1 where id = $2`, [
        token,
        destination.id,
      ]);
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, permission, token
         ) values ('page', $1, $2, 'edit', $3)`,
        [destination.id, owner.id, token],
      );
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')`,
        [visibleTarget.id, owner.id, importer.id],
      );

      const res = await app.request(`/api/pages/${destination.id}/import/markdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({
          markdown: 'See [[Visible reference]] and [[Private reference]]',
        }),
      });

      expect(res.status).toBe(200);
      const stored = await query<{ ydoc: Buffer }>('select ydoc from pages where id = $1', [
        destination.id,
      ]);
      const connections = extractConnectionsFromYDoc(new Uint8Array(stored.rows[0]?.ydoc ?? []));
      expect(connections).toContainEqual(
        expect.objectContaining({ targetSlug: 'visible reference' }),
      );
      expect(connections.every((connection) => connection.targetId === undefined)).toBe(true);
      expect(
        connections.find((connection) => connection.targetSlug === 'private reference')?.targetId,
      ).toBeUndefined();
      expect(connections.some((connection) => connection.targetId === hiddenTarget.id)).toBe(false);
      expect(connections.some((connection) => connection.targetId === hiddenDuplicate.id)).toBe(
        false,
      );
      expect(stored.rows[0]?.ydoc.includes(Buffer.from(visibleTarget.id))).toBe(false);
    });

    it('resolves targets after a queued revoke has linearized', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const importer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const importerSession = await createTestSession(importer.id);
      const destination = await createTestPage(owner.id, { title: 'Serialized import' });
      const target = await createTestPage(owner.id, { title: 'Revoked reference' });
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'edit')`,
        [destination.id, owner.id, importer.id],
      );
      const targetShare = await query<{ id: string }>(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')
         returning id`,
        [target.id, owner.id, importer.id],
      );
      const targetShareId = targetShare.rows[0]?.id;
      if (!targetShareId) throw new Error('Failed to create target share');

      let releaseBlocker = (): void => undefined;
      const blockerRelease = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      let signalBlockerReady = (_pid: number): void => undefined;
      const blockerReady = new Promise<number>((resolve) => {
        signalBlockerReady = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await lockWorkspaceAccessMutation(tx, owner.id);
        const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
        const pid = pidResult.rows[0]?.pid;
        if (pid === undefined) throw new Error('Failed to resolve blocker PID');
        signalBlockerReady(pid);
        await blockerRelease;
      });
      const blockerPid = await blockerReady;
      const revokePromise = app.request(`/api/shares/${targetShareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      let importPromise: Promise<Response> | null = null;

      try {
        await waitForWorkspaceLockWaiter(blockerPid);
        const queuedImport = Promise.resolve(
          app.request(`/api/pages/${destination.id}/import/markdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: importerSession.Cookie },
            body: JSON.stringify({ markdown: 'See [[Revoked reference]]' }),
          }),
        );
        importPromise = queuedImport;
        await waitForWorkspaceLockWaiter(blockerPid, 2);
        releaseBlocker();

        expect((await revokePromise).status).toBe(200);
        expect((await queuedImport).status).toBe(200);
        const stored = await query<{ ydoc: Buffer }>('select ydoc from pages where id = $1', [
          destination.id,
        ]);
        const connections = extractConnectionsFromYDoc(new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(
          connections.find((connection) => connection.targetSlug === 'revoked reference')?.targetId,
        ).toBeUndefined();
        expect(connections.some((connection) => connection.targetId === target.id)).toBe(false);
      } finally {
        releaseBlocker();
        await blocker;
        await Promise.allSettled([revokePromise, ...(importPromise ? [importPromise] : [])]);
      }
    });

    it('returns 415 for unsupported content type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: 'plain text',
      });
      expect(res.status).toBe(415);
    });

    it('returns 400 for empty markdown', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ markdown: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/pages/:id/copy', () => {
    it('creates a copy of the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Original' });

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('Copy of Original');
      expect(body.id).not.toBe(page.id);
    });

    it('keeps copied titles within the collaboration title limit', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const sourceTitle = 'x'.repeat(MAX_PAGE_TITLE_LENGTH);
      const page = await createTestPage(user.id, { title: sourceTitle });

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { title: string };
      expect(body.title).toHaveLength(MAX_PAGE_TITLE_LENGTH);
      expect(body.title).toBe(`Copy of ${sourceTitle}`.slice(0, MAX_PAGE_TITLE_LENGTH));
    });

    it('copies astral titles without splitting a Unicode character', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const sourceTitle = '📚'.repeat(MAX_PAGE_TITLE_LENGTH);
      const page = await createTestPage(user.id, { title: sourceTitle });

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { title: string };
      expect(Array.from(body.title)).toHaveLength(MAX_PAGE_TITLE_LENGTH);
      expect(body.title).toBe(`Copy of ${'📚'.repeat(MAX_PAGE_TITLE_LENGTH - 8)}`);
      expect(body.title).not.toContain('�');
    });

    it('allows a viewer to copy a shared page into their own workspace', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Shared Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });

      expect(res.status).toBe(201);
      const copied = await res.json();
      expect(copied.createdBy).toBe(viewer.id);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/pages/:id/permanent', () => {
    it('requires the owner to move the page to Trash first', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const activeRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(activeRes.status).toBe(409);

      const softDeleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(softDeleteRes.status).toBe(200);

      const res = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('does not let a non-owner Admin purge a trashed page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const page = await createTestPage(owner.id);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'admin')`,
        [page.id, owner.id, admin.id],
      );

      const activePurgeRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(activePurgeRes.status).toBe(403);

      const softDeleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(softDeleteRes.status).toBe(200);

      const purgeRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(purgeRes.status).toBe(403);

      const ownerPurgeRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(ownerPurgeRes.status).toBe(200);
    });

    it('removes polymorphic sharing, access, and favorite metadata', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);
      const token = crypto.randomUUID();
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, token],
      );
      await query(
        `insert into page_access_events (page_id, user_id, source, token, permission)
         values ($1, $2, 'link', $3, 'view')`,
        [page.id, recipient.id, token],
      );
      await query(
        `insert into user_favorites (user_id, entity_type, entity_id)
         values ($1, 'page', $2)`,
        [recipient.id, page.id],
      );

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      const purgeRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(purgeRes.status).toBe(200);

      const leftovers = await query<{ shares: string; events: string; favorites: string }>(
        `select
           (select count(*) from shares where entity_type = 'page' and entity_id = $1)::text as shares,
           (select count(*) from page_access_events where page_id = $1)::text as events,
           (select count(*) from user_favorites where entity_type = 'page' and entity_id = $1)::text as favorites`,
        [page.id],
      );
      expect(leftovers.rows[0]).toEqual({ shares: '0', events: '0', favorites: '0' });
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/permanent', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/pages/:id', () => {
    it('returns a specific page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, {
        title: 'My Page',
      });

      const res = await app.request(`/api/pages/${page.id}`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('My Page');
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000', {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/pages/:id', () => {
    it('updates a page title', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, {
        title: 'Original',
      });
      const revisionBefore = await readWorkspaceAccessVersion(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Updated Title');
      expect(await readWorkspaceAccessVersion(user.id)).toBe(revisionBefore);
    });

    it('rejects signed-in title updates longer than 250 characters', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Original' });

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'T'.repeat(251) }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'Title must be 250 characters or fewer' });
    });

    it('rejects a non-numeric page position', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'not-a-number' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('allows editors to update page content metadata', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const page = await createTestPage(owner.id, { title: 'Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'Edited', icon: 'x', properties: { tags: ['shared'] } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Edited');
      expect(body.icon).toBe('x');
    });

    it('returns 400 when setting parentId to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: page.id }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent parentId', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: '00000000-0000-0000-0000-000000000000' }),
      });
      expect(res.status).toBe(404);
    });

    it('updates properties as JSON', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ properties: { status: 'done', priority: 1 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.properties).toEqual({ status: 'done', priority: 1 });
    });
  });

  describe('DELETE /api/pages/:id', () => {
    it('soft-deletes a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });
  });

  describe('POST /api/pages/:id/leave', () => {
    it('returns 401 without session', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when user owns the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Cannot leave your own page');
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/leave', {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(404);
    });

    it('removes share row for email-invited page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id);

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const shareCheck = await query(
        `SELECT id FROM shares WHERE entity_id = $1 AND recipient_user_id = $2`,
        [page.id, recipient.id],
      );
      expect(shareCheck.rowCount).toBe(0);
    });

    it('removes link provenance and notifies both visitor access and owner metadata', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(owner.id);

      await query(
        `INSERT INTO page_access_events (page_id, user_id, source, token, permission, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'link', 'test-token', 'view', now(), now())`,
        [page.id, user.id],
      );

      const listener = new Client({ connectionString });
      const payloads: string[] = [];
      listener.on('notification', (notification) => {
        if (notification.channel === 'share_event' && notification.payload) {
          payloads.push(notification.payload);
        }
      });
      await listener.connect();
      await listener.query('listen share_event');

      try {
        const res = await app.request(`/api/pages/${page.id}/leave`, {
          method: 'POST',
          headers: {
            Cookie: session.Cookie,
            Origin: 'http://localhost:5173',
          },
        });
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);

        const paeCheck = await query(
          `SELECT id FROM page_access_events WHERE page_id = $1 AND user_id = $2`,
          [page.id, user.id],
        );
        expect(paeCheck.rowCount).toBe(0);

        const notifications = await flushShareEventNotifications(payloads);
        expect(notifications).toContainEqual(
          expect.objectContaining({
            action: 'revoke',
            entityType: 'page',
            entityId: page.id,
            targetUserId: user.id,
            metaUserIds: [owner.id],
          }),
        );
      } finally {
        await listener.end();
      }
    });

    it('rejects leave requests with no direct share or link-access record', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const session = await createTestSession(stranger.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(409);
    });
  });
});
