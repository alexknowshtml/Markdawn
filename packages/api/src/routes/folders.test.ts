import { MAX_PAGE_TITLE_LENGTH } from '@markdawn/shared';
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

async function waitForBlockedRequests(blockerPid: number, minimumCount: number): Promise<void> {
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
  throw new Error(`Timed out waiting for ${minimumCount} blocked trash requests`);
}

const PRIVATE_FOLDER_DETAIL_FIELDS = [
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
] as const;

function expectFolderFieldsAbsent(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    expect(Object.hasOwn(value, field), `expected ${field} to be absent`).toBe(false);
  }
}

type FolderShareEventNotification = {
  type: 'share_event';
  action: string;
  entityType: 'page' | 'folder';
  entityId: string;
  targetUserId?: string;
  metaUserIds?: string[];
  metaOnly?: boolean;
};

async function flushFolderShareEventNotifications(
  payloads: string[],
): Promise<FolderShareEventNotification[]> {
  const marker = `test-notification-marker:${crypto.randomUUID()}`;
  await query("select pg_notify('share_event', $1)", [marker]);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const markerIndex = payloads.indexOf(marker);
    if (markerIndex >= 0) {
      const batch = payloads.splice(0, markerIndex + 1).slice(0, -1);
      return batch.flatMap((payload) => {
        try {
          const parsed = JSON.parse(payload) as Partial<FolderShareEventNotification>;
          return parsed.type === 'share_event' && parsed.entityId
            ? [parsed as FolderShareEventNotification]
            : [];
        } catch {
          return [];
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out flushing folder share event notifications');
}

describe('folders API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/folders/tree');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/folders/tree', () => {
    it('returns folder tree for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestFolder(user.id);

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('marks roots available through workspace membership', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const session = await createTestSession(member.id);
      const folder = await createTestFolder(owner.id);
      await createTestWorkspaceMember(owner.id, member.id, 'editor');

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toContainEqual(
        expect.objectContaining({
          id: folder.id,
          workspaceAccess: true,
          userPermission: 'edit',
        }),
      );
    });
  });

  describe('POST /api/folders', () => {
    it('creates a folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'New Folder' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Folder');
    });

    it('creates a nested folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: parent.id, name: 'Child' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.parentId).toBe(parent.id);
    });

    it('returns 404 for non-existent parent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          parentId: '00000000-0000-0000-0000-000000000000',
          name: 'Orphan',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects writes beneath a folder deleted after the caller checked it', async () => {
      const user = await createTestUser();
      const parent = await createTestFolder(user.id);
      await query('update folders set is_deleted = true, deleted_at = now() where id = $1', [
        parent.id,
      ]);

      await expect(
        query(
          `insert into folders (parent_id, name, position, created_by)
           values ($1, 'Too late', '0', $2)`,
          [parent.id, user.id],
        ),
      ).rejects.toThrow('Cannot place content inside a deleted folder');
    });

    it('requires admin access to create a nested folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const parent = await createTestFolder(owner.id);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [parent.id, owner.id, editor.id],
      );

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: parent.id, name: 'Not allowed' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/folders/:id', () => {
    it('returns a specific folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Specific' });
      const revisionBefore = await readWorkspaceAccessVersion(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Specific');
      expect(await readWorkspaceAccessVersion(user.id)).toBe(revisionBefore);
    });

    it('orders a queued revoke before a later authenticated folder read', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const viewerSession = await createTestSession(viewer.id);
      const folder = await createTestFolder(owner.id, { name: 'Revoke read race' });
      const share = await query<{ id: string }>(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('folder', $1, $2, $3, 'view')
         returning id`,
        [folder.id, owner.id, viewer.id],
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
      const revokePromise = Promise.resolve(
        app.request(`/api/shares/${shareId}`, {
          method: 'DELETE',
          headers: { Cookie: ownerSession.Cookie },
        }),
      );
      let readPromise: Promise<Response> | null = null;

      try {
        await waitForBlockedRequests(blockerPid, 1);
        const queuedRead = Promise.resolve(
          app.request(`/api/folders/${folder.id}`, {
            headers: { Cookie: viewerSession.Cookie },
          }),
        );
        readPromise = queuedRead;
        await waitForBlockedRequests(blockerPid, 2);
        releaseBlocker();

        const revokeResponse = await revokePromise;
        const readResponse = await queuedRead;
        expect(revokeResponse.status).toBe(200);
        // The public-capable route is registered first and intentionally hides
        // a now-private folder after the account grant disappears.
        expect(readResponse.status).toBe(404);
      } finally {
        releaseBlocker();
        await blocker;
        await Promise.allSettled([revokePromise, ...(readPromise ? [readPromise] : [])]);
      }
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns public folder children without a session', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id, { name: 'Public Folder' });
      const page = await createTestPage(owner.id, { parentId: folder.id, title: 'Child Page' });
      const childFolder = await createTestFolder(owner.id, {
        parentId: folder.id,
        name: 'Child Folder',
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
      const revisionBefore = await query<{ version: string }>(
        `select coalesce((
           select version::text from workspace_access_versions where workspace_owner_id = $1
         ), '0') as version`,
        [owner.id],
      );

      expect((await app.request(`/api/folders/${folder.id}`)).status).toBe(404);
      expect(
        (await app.request(`/api/folders/${folder.id}?share=${crypto.randomUUID()}`)).status,
      ).toBe(404);

      const res = await app.request(`/api/folders/${folder.id}?share=${token}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & {
        pages: Record<string, unknown>[];
        folders: Record<string, unknown>[];
      };
      expect(body.name).toBe('Public Folder');
      expect(body.linkPermission).toBe('view');
      const publicPage = body.pages.find((item) => item.id === page.id);
      const publicChildFolder = body.folders.find((item) => item.id === childFolder.id);
      expect(publicPage).toBeDefined();
      expect(publicChildFolder).toBeDefined();
      expectFolderFieldsAbsent(body, PRIVATE_FOLDER_DETAIL_FIELDS);
      expectFolderFieldsAbsent(publicPage ?? {}, PRIVATE_FOLDER_DETAIL_FIELDS);
      expectFolderFieldsAbsent(publicChildFolder ?? {}, PRIVATE_FOLDER_DETAIL_FIELDS);

      expect((await app.request(`/api/folders/${folder.id}?share=${token}`)).status).toBe(200);
      const revisionAfter = await query<{ version: string }>(
        `select coalesce((
           select version::text from workspace_access_versions where workspace_owner_id = $1
         ), '0') as version`,
        [owner.id],
      );
      expect(revisionAfter.rows[0]?.version).toBe(revisionBefore.rows[0]?.version);
    });

    it('returns minimal link-only DTOs and keeps provenance reads revision-neutral', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const visitor = await createTestUser();
      const visitorSession = await createTestSession(visitor.id);
      const folder = await createTestFolder(owner.id, { name: 'Signed public folder' });
      const page = await createTestPage(owner.id, { parentId: folder.id, title: 'Signed child' });
      const childFolder = await createTestFolder(owner.id, {
        parentId: folder.id,
        name: 'Signed folder child',
      });
      const token = crypto.randomUUID();
      await query('update folders set is_public = true, public_token = $1 where id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('folder', $1, $2, 'view', $3)`,
        [folder.id, owner.id, token],
      );
      const readVersion = async (): Promise<string> => {
        const result = await query<{ version: string }>(
          `select coalesce((
             select version::text from workspace_access_versions where workspace_owner_id = $1
           ), '0') as version`,
          [owner.id],
        );
        return result.rows[0]?.version ?? '0';
      };
      const before = await readVersion();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.request(`/api/folders/${folder.id}`, {
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': token },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown> & {
          pages: Record<string, unknown>[];
          folders: Record<string, unknown>[];
        };
        expectFolderFieldsAbsent(body, PRIVATE_FOLDER_DETAIL_FIELDS);
        expectFolderFieldsAbsent(
          body.pages.find((item) => item.id === page.id) ?? {},
          PRIVATE_FOLDER_DETAIL_FIELDS,
        );
        expectFolderFieldsAbsent(
          body.folders.find((item) => item.id === childFolder.id) ?? {},
          PRIVATE_FOLDER_DETAIL_FIELDS,
        );
      }
      expect(await readVersion()).toBe(before);
      const provenance = await query<{ count: string }>(
        `select count(*)::text as count
         from folder_access_events
         where folder_id = $1 and user_id = $2 and token = $3`,
        [folder.id, visitor.id, token],
      );
      expect(provenance.rows[0]?.count).toBe('1');
    });

    it('returns an explicit authenticated folder DTO for an account source', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const viewerSession = await createTestSession(viewer.id);
      const folder = await createTestFolder(owner.id, { name: 'Account folder' });
      const child = await createTestPage(owner.id, { parentId: folder.id, title: 'Account child' });
      const token = crypto.randomUUID();
      await query('update folders set is_public = true, public_token = $1 where id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission, token
         ) values
           ('folder', $1, $2, $3, 'view', null),
           ('folder', $1, $2, null, 'edit', $4)`,
        [folder.id, owner.id, viewer.id, token],
      );

      const response = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: viewerSession.Cookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown> & {
        pages: Record<string, unknown>[];
      };
      expect(body).toMatchObject({
        id: folder.id,
        createdBy: owner.id,
        ownerId: owner.id,
        userPermission: 'edit',
      });
      expect(body.pages).toContainEqual(
        expect.objectContaining({ id: child.id, createdBy: owner.id, ownerId: owner.id }),
      );
      expectFolderFieldsAbsent(body, [
        'created_by',
        'owner_id',
        'publicToken',
        'public_token',
        'isDeleted',
        'is_deleted',
        'deletedAt',
        'deleted_at',
      ]);
    });

    it('allows anonymous access to descendant folders through an ancestor folder link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const parent = await createTestFolder(owner.id, { name: 'Public Parent' });
      const child = await createTestFolder(owner.id, { name: 'Public Child', parentId: parent.id });
      const token = crypto.randomUUID();

      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        parent.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [parent.id, owner.id, token],
      );

      const res = await app.request(`/api/folders/${child.id}?share=${token}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Public Child');
      expect(body.isPublic).toBe(true);
      expect(body.linkPermission).toBe('view');
    });
  });

  describe('PATCH /api/folders/:id', () => {
    it('updates a folder name', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Old' });
      const revisionBefore = await readWorkspaceAccessVersion(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Updated', position: '42' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
      expect(body.position).toBe('42');
      expect(await readWorkspaceAccessVersion(user.id)).toBe(revisionBefore);
    });

    it('advances the access revision when the parent changes', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const destination = await createTestFolder(owner.id);
      const revisionBefore = await readWorkspaceAccessVersion(owner.id);

      const response = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destination.id }),
      });

      expect(response.status).toBe(200);
      expect(BigInt(await readWorkspaceAccessVersion(owner.id))).toBeGreaterThan(
        BigInt(revisionBefore),
      );
    });

    it('rejects a non-numeric folder position', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'not-a-number' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('does not let editors rename folders', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const folder = await createTestFolder(owner.id, { name: 'Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [folder.id, owner.id, editor.id],
      );

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ name: 'Not allowed' }),
      });

      expect(res.status).toBe(403);
    });

    it('prevents setting parent to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: folder.id }),
      });

      expect(res.status).toBe(400);
    });

    it('prevents deep cycle (moving ancestor into descendant)', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id, { name: 'Parent' });
      const child = await createTestFolder(user.id, {
        name: 'Child',
        parentId: parent.id,
      });

      const res = await app.request(`/api/folders/${parent.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: child.id }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects moving into a deleted folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Target' });
      const deleted = await createTestFolder(user.id, { name: 'Deleted' });

      await app.request(`/api/folders/${deleted.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: deleted.id }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects moving a shared folder into a folder the caller cannot edit', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(collaborator.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared' });
      const forbiddenParent = await createTestFolder(otherOwner.id, { name: 'Forbidden' });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [folder.id, owner.id, collaborator.id],
      );

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: forbiddenParent.id }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Ghost' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/folders/:id/copy', () => {
    it('copies a folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Original' });

      const res = await app.request(`/api/folders/${folder.id}/copy`, {
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
      expect(body.name).toContain('Copy of');
    });

    it('copies page connection indexes and occurrences', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      const page = await createTestPage(user.id, { parentId: folder.id, title: 'Tagged' });
      const connection = await query<{ id: string }>(
        `INSERT INTO connections (
           source_type, source_id, target_type, target_slug, target_label,
           connection_type, link_text, link_context, occurrence_count
         ) VALUES ('page', $1, 'tag', '#roadmap', '#roadmap', 'tag', '#roadmap', 'context', 1)
         RETURNING id`,
        [page.id],
      );
      await query(
        `INSERT INTO connection_occurrences (connection_id, source_block_id, position, context)
         VALUES ($1, 'block-1', 12, 'occurrence context')`,
        [connection.rows[0]?.id],
      );

      const res = await app.request(`/api/folders/${folder.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });
      const copiedFolder = (await res.json()) as { id: string };
      const copiedPage = await query<{ id: string }>(
        'SELECT id FROM pages WHERE parent_id = $1 AND title = $2',
        [copiedFolder.id, 'Copy of Tagged'],
      );
      const copiedIndex = await query<{
        source_block_id: string | null;
        position: number | null;
        context: string | null;
      }>(
        `SELECT occurrence.source_block_id, occurrence.position, occurrence.context
         FROM connections connection
         JOIN connection_occurrences occurrence ON occurrence.connection_id = connection.id
         WHERE connection.source_id = $1 AND connection.target_slug = '#roadmap'`,
        [copiedPage.rows[0]?.id],
      );

      expect(res.status).toBe(201);
      expect(copiedIndex.rows).toEqual([
        { source_block_id: 'block-1', position: 12, context: 'occurrence context' },
      ]);
    });

    it('lets viewers copy accessible content while skipping restricted descendants', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const root = await createTestFolder(owner.id, { name: 'Shared Root' });
      const restricted = await createTestFolder(owner.id, {
        name: 'Restricted Child',
        parentId: root.id,
      });
      await createTestPage(owner.id, { title: 'Private Child', parentId: restricted.id });
      await query("UPDATE folders SET inheritance_policy = 'restricted' WHERE id = $1", [
        restricted.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'view')`,
        [root.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/folders/${root.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.skippedRestrictedItems).toBe(true);
      const privateCopy = await query('SELECT id FROM pages WHERE title = $1 AND created_by = $2', [
        'Copy of Private Child',
        viewer.id,
      ]);
      expect(privateCopy.rowCount).toBe(0);
    });

    it('keeps recursively copied page titles within the collaboration title limit', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id, { name: 'Copy source' });
      const sourceTitle = 'x'.repeat(MAX_PAGE_TITLE_LENGTH);
      await createTestPage(owner.id, { parentId: folder.id, title: sourceTitle });

      const res = await app.request(`/api/folders/${folder.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });

      expect(res.status).toBe(201);
      const copiedPage = await query<{ title: string }>(
        `select title
         from pages
         where title like 'Copy of %' and created_by = $1
         order by created_at desc
         limit 1`,
        [owner.id],
      );
      expect(copiedPage.rows[0]?.title).toHaveLength(MAX_PAGE_TITLE_LENGTH);
      expect(copiedPage.rows[0]?.title).toBe(
        `Copy of ${sourceTitle}`.slice(0, MAX_PAGE_TITLE_LENGTH),
      );
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('public-link provenance', () => {
    it('preserves link navigation when a stronger direct folder grant is revoked', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Public fallback folder' });
      const token = crypto.randomUUID();
      const invite = await query<{ id: string }>(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('folder', $1, $2, $3, 'edit') returning id`,
        [folder.id, owner.id, recipient.id],
      );
      await query('update folders set is_public = true, public_token = $1 where id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('folder', $1, $2, 'view', $3)`,
        [folder.id, owner.id, token],
      );

      const openRes = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: recipientSession.Cookie, 'x-share-token': token },
      });
      expect(openRes.status).toBe(200);

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
        expect.objectContaining({ entityType: 'folder', entityId: folder.id, source: 'link' }),
      );
    });

    it('notifies on first visit and event-only leave without refreshing metadata noisily', async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL is required');

      const app = await createTestApp();
      const owner = await createTestUser();
      const visitor = await createTestUser();
      const visitorSession = await createTestSession(visitor.id);
      const folder = await createTestFolder(owner.id, { name: 'Notification provenance' });
      const token = crypto.randomUUID();
      await query('update folders set is_public = true, public_token = $1 where id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('folder', $1, $2, 'view', $3)`,
        [folder.id, owner.id, token],
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
        const firstVisit = await app.request(`/api/folders/${folder.id}`, {
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': token },
        });
        expect(firstVisit.status).toBe(200);
        const firstNotifications = (await flushFolderShareEventNotifications(payloads)).filter(
          (payload) => payload.targetUserId === visitor.id,
        );
        expect(firstNotifications).toEqual([
          expect.objectContaining({
            action: 'recompute',
            entityType: 'folder',
            entityId: folder.id,
            targetUserId: visitor.id,
            metaUserIds: [visitor.id],
            metaOnly: true,
          }),
        ]);

        const repeatVisit = await app.request(`/api/folders/${folder.id}`, {
          headers: { Cookie: visitorSession.Cookie, 'x-share-token': token },
        });
        expect(repeatVisit.status).toBe(200);
        const repeatNotifications = (await flushFolderShareEventNotifications(payloads)).filter(
          (payload) => payload.targetUserId === visitor.id,
        );
        expect(repeatNotifications).toEqual([]);

        const leaveResponse = await app.request(`/api/folders/${folder.id}/leave`, {
          method: 'POST',
          headers: { Cookie: visitorSession.Cookie },
        });
        expect(leaveResponse.status).toBe(200);
        const leaveNotifications = (await flushFolderShareEventNotifications(payloads)).filter(
          (payload) => payload.targetUserId === visitor.id,
        );
        expect(leaveNotifications).toEqual([
          expect.objectContaining({
            action: 'revoke',
            entityType: 'folder',
            entityId: folder.id,
            targetUserId: visitor.id,
            metaUserIds: [owner.id],
          }),
        ]);

        const storedEvents = await query<{ count: string }>(
          `select count(*)::text as count
           from folder_access_events
           where folder_id = $1 and user_id = $2`,
          [folder.id, visitor.id],
        );
        expect(storedEvents.rows[0]?.count).toBe('0');
      } finally {
        await listener.end();
      }
    });
  });

  describe('DELETE /api/folders/:id', () => {
    it('soft-deletes an empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('deletes a parent after its child was already soft-deleted', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id, { name: 'Parent' });
      const child = await createTestFolder(user.id, { name: 'Child', parentId: parent.id });

      const childRes = await app.request(`/api/folders/${child.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(childRes.status).toBe(200);

      const parentRes = await app.request(`/api/folders/${parent.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(parentRes.status).toBe(200);
      expect(await parentRes.json()).toEqual({ deleted: true });
    });

    it('requires force flag for non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      await createTestPage(user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'FOLDER_NOT_EMPTY', requiresForce: true });
    });

    it('force-deletes a non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      await createTestPage(user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('rolls back every descendant when a forced deletion fails', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const root = await createTestFolder(user.id, { name: 'Root' });
      const child = await createTestFolder(user.id, { name: 'Child', parentId: root.id });
      const page = await createTestPage(user.id, { title: 'Fail deletion', parentId: child.id });

      await query(`
        CREATE OR REPLACE FUNCTION reject_test_page_deletion() RETURNS trigger AS $$
        BEGIN
          IF NEW.is_deleted = true AND NEW.title = 'Fail deletion' THEN
            RAISE EXCEPTION 'forced deletion failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_test_page_deletion_trigger
        BEFORE UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION reject_test_page_deletion();
      `);

      try {
        const res = await app.request(`/api/folders/${root.id}?force=true`, {
          method: 'DELETE',
          headers: { Cookie: session.Cookie },
        });
        expect(res.status).toBe(500);

        const folders = await query<{ id: string; is_deleted: boolean }>(
          'SELECT id, is_deleted FROM folders WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[root.id, child.id]],
        );
        expect(folders.rows.every((row) => row.is_deleted === false)).toBe(true);
        const storedPage = await query<{ is_deleted: boolean }>(
          'SELECT is_deleted FROM pages WHERE id = $1',
          [page.id],
        );
        expect(storedPage.rows[0]?.is_deleted).toBe(false);
      } finally {
        await query('DROP TRIGGER IF EXISTS reject_test_page_deletion_trigger ON pages');
        await query('DROP FUNCTION IF EXISTS reject_test_page_deletion()');
      }
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('folder Trash lifecycle', () => {
    it('lists a deleted subtree once and restores the deletion batch', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const root = await createTestFolder(owner.id, { name: 'Trash Root' });
      const child = await createTestFolder(owner.id, { name: 'Trash Child', parentId: root.id });
      const page = await createTestPage(owner.id, { title: 'Trash Page', parentId: child.id });

      const deleteRes = await app.request(`/api/folders/${root.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(deleteRes.status).toBe(200);
      const deletionBatch = await query<{ deletion_batch_id: string | null }>(
        `select deletion_batch_id from folders where id = $1
         union all
         select deletion_batch_id from folders where id = $2
         union all
         select deletion_batch_id from pages where id = $3`,
        [root.id, child.id, page.id],
      );
      const batchIds = deletionBatch.rows.map((row) => row.deletion_batch_id);
      expect(batchIds.every((batchId) => batchId !== null)).toBe(true);
      expect(new Set(batchIds).size).toBe(1);

      const trashRes = await app.request('/api/folders/trash', {
        headers: { Cookie: session.Cookie },
      });
      expect(trashRes.status).toBe(200);
      const trash = (await trashRes.json()) as Array<{ id: string; name: string }>;
      expect(trash).toContainEqual(expect.objectContaining({ id: root.id, name: 'Trash Root' }));
      expect(trash).not.toContainEqual(expect.objectContaining({ id: child.id }));

      const restoreRes = await app.request(`/api/folders/${root.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie },
      });
      expect(restoreRes.status).toBe(200);
      expect(await restoreRes.json()).toMatchObject({
        id: root.id,
        restoredFolders: 2,
        restoredPages: 1,
      });

      const restoredFolders = await query<{ id: string; is_deleted: boolean }>(
        'select id, is_deleted from folders where id = any($1::uuid[]) order by id',
        [[root.id, child.id]],
      );
      expect(restoredFolders.rows.every((row) => row.is_deleted === false)).toBe(true);
      const restoredPage = await query<{ is_deleted: boolean }>(
        'select is_deleted from pages where id = $1',
        [page.id],
      );
      expect(restoredPage.rows[0]?.is_deleted).toBe(false);
    });

    it('leaves an independently trashed descendant deleted when restoring its parent', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const root = await createTestFolder(owner.id, { name: 'Parent' });
      const child = await createTestFolder(owner.id, {
        name: 'Already deleted',
        parentId: root.id,
      });

      const childDeleteRes = await app.request(`/api/folders/${child.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(childDeleteRes.status).toBe(200);
      const childBatch = await query<{ deletion_batch_id: string | null }>(
        'select deletion_batch_id from folders where id = $1',
        [child.id],
      );
      const rootDeleteRes = await app.request(`/api/folders/${root.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(rootDeleteRes.status).toBe(200);
      const rootBatch = await query<{ deletion_batch_id: string | null }>(
        'select deletion_batch_id from folders where id = $1',
        [root.id],
      );
      expect(rootBatch.rows[0]?.deletion_batch_id).toBeTruthy();
      expect(rootBatch.rows[0]?.deletion_batch_id).not.toBe(childBatch.rows[0]?.deletion_batch_id);

      const restoreRes = await app.request(`/api/folders/${root.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie },
      });
      expect(restoreRes.status).toBe(200);
      expect(await restoreRes.json()).toMatchObject({ restoredFolders: 1, restoredPages: 0 });

      const storedChild = await query<{ is_deleted: boolean }>(
        'select is_deleted from folders where id = $1',
        [child.id],
      );
      expect(storedChild.rows[0]?.is_deleted).toBe(true);
    });

    it('requires Trash and ownership before permanent deletion', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const folder = await createTestFolder(owner.id);
      await query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('folder', $1, $2, $3, 'admin')`,
        [folder.id, owner.id, admin.id],
      );

      const activePurge = await app.request(`/api/folders/${folder.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(activePurge.status).toBe(409);
      const activeAdminPurge = await app.request(`/api/folders/${folder.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(activeAdminPurge.status).toBe(403);

      const deleteRes = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(deleteRes.status).toBe(200);
      const adminPurge = await app.request(`/api/folders/${folder.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: adminSession.Cookie },
      });
      expect(adminPurge.status).toBe(403);
      const ownerPurge = await app.request(`/api/folders/${folder.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(ownerPurge.status).toBe(200);
    });

    it('purges subtree shares, link access records, and favorites', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(owner.id);
      const root = await createTestFolder(owner.id);
      const child = await createTestFolder(owner.id, { parentId: root.id });
      const page = await createTestPage(owner.id, { parentId: child.id });
      const folderToken = crypto.randomUUID();
      const pageToken = crypto.randomUUID();
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('folder', $1, $3, 'view', $4), ('page', $2, $3, 'view', $5)`,
        [child.id, page.id, owner.id, folderToken, pageToken],
      );
      await query(
        `insert into folder_access_events (folder_id, user_id, source, token, permission)
         values ($1, $2, 'link', $3, 'view')`,
        [child.id, recipient.id, folderToken],
      );
      await query(
        `insert into page_access_events (page_id, user_id, source, token, permission)
         values ($1, $2, 'link', $3, 'view')`,
        [page.id, recipient.id, pageToken],
      );
      await query(
        `insert into user_favorites (user_id, entity_type, entity_id)
         values ($1, 'folder', $2), ($1, 'page', $3)`,
        [recipient.id, child.id, page.id],
      );

      await app.request(`/api/folders/${root.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      const purgeRes = await app.request(`/api/folders/${root.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(purgeRes.status).toBe(200);
      expect(await purgeRes.json()).toMatchObject({ deleted: true, folders: 2, pages: 1 });

      const leftovers = await query<{
        shares: string;
        folder_events: string;
        page_events: string;
        favorites: string;
      }>(
        `select
           (select count(*) from shares where entity_id = any($1::uuid[]))::text as shares,
           (select count(*) from folder_access_events where folder_id = any($1::uuid[]))::text as folder_events,
           (select count(*) from page_access_events where page_id = $2)::text as page_events,
           (select count(*) from user_favorites where entity_id = any($1::uuid[]))::text as favorites`,
        [[root.id, child.id, page.id], page.id],
      );
      expect(leftovers.rows[0]).toEqual({
        shares: '0',
        folder_events: '0',
        page_events: '0',
        favorites: '0',
      });
    });

    it('serializes descendant restore before ancestor purge without stripping survivor metadata', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(owner.id);
      const root = await createTestFolder(owner.id, { name: 'Purged root' });
      const child = await createTestFolder(owner.id, {
        name: 'Restored child',
        parentId: root.id,
      });
      const page = await createTestPage(owner.id, { parentId: child.id });
      const folderToken = crypto.randomUUID();
      const pageToken = crypto.randomUUID();
      await query(
        `insert into shares (entity_type, entity_id, shared_by, permission, token)
         values ('folder', $1, $3, 'view', $4), ('page', $2, $3, 'view', $5)`,
        [child.id, page.id, owner.id, folderToken, pageToken],
      );
      await query(
        `insert into folder_access_events (folder_id, user_id, source, token, permission)
         values ($1, $2, 'link', $3, 'view')`,
        [child.id, recipient.id, folderToken],
      );
      await query(
        `insert into page_access_events (page_id, user_id, source, token, permission)
         values ($1, $2, 'link', $3, 'view')`,
        [page.id, recipient.id, pageToken],
      );
      await query(
        `insert into user_favorites (user_id, entity_type, entity_id)
         values ($1, 'folder', $2), ($1, 'page', $3)`,
        [recipient.id, child.id, page.id],
      );

      const trashRes = await app.request(`/api/folders/${root.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(trashRes.status).toBe(200);

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
        if (!pid) throw new Error('Failed to resolve trash lock blocker PID');
        reportBlockerPid(pid);
        await blockerReleased;
      });

      const blockerPid = await blockerReady;
      const restorePromise = Promise.resolve(
        app.request(`/api/folders/${child.id}/restore`, {
          method: 'PATCH',
          headers: { Cookie: session.Cookie },
        }),
      );
      let purgePromise: Promise<Response> | null = null;
      let orchestrationError: unknown = null;
      try {
        await waitForBlockedRequests(blockerPid, 1);
        purgePromise = Promise.resolve(
          app.request(`/api/folders/${root.id}/permanent`, {
            method: 'DELETE',
            headers: { Cookie: session.Cookie },
          }),
        );
        await waitForBlockedRequests(blockerPid, 2);
      } catch (error) {
        orchestrationError = error;
      } finally {
        releaseBlocker();
        await blocker;
      }
      if (orchestrationError) {
        await restorePromise;
        if (purgePromise) await purgePromise;
        throw orchestrationError;
      }
      if (!purgePromise) throw new Error('Purge request was not started');

      const [restoreRes, purgeRes] = await Promise.all([restorePromise, purgePromise]);
      expect(restoreRes.status).toBe(200);
      expect(purgeRes.status).toBe(200);

      const survivors = await query<{
        child_deleted: boolean;
        child_parent: string | null;
        page_deleted: boolean;
        shares: string;
        folder_events: string;
        page_events: string;
        favorites: string;
      }>(
        `select
           child.is_deleted as child_deleted,
           child.parent_id as child_parent,
           page.is_deleted as page_deleted,
           (select count(*) from shares where entity_id = any($1::uuid[]))::text as shares,
           (select count(*) from folder_access_events where folder_id = $2)::text as folder_events,
           (select count(*) from page_access_events where page_id = $3)::text as page_events,
           (select count(*) from user_favorites where entity_id = any($1::uuid[]))::text as favorites
         from folders child
         join pages page on page.id = $3
         where child.id = $2`,
        [[child.id, page.id], child.id, page.id],
      );
      expect(survivors.rows[0]).toEqual({
        child_deleted: false,
        child_parent: null,
        page_deleted: false,
        shares: '2',
        folder_events: '1',
        page_events: '1',
        favorites: '2',
      });
    });

    it('empties all top-level folder trash roots', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const first = await createTestFolder(owner.id);
      const second = await createTestFolder(owner.id);
      await app.request(`/api/folders/${first.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      await app.request(`/api/folders/${second.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      const emptyRes = await app.request('/api/folders/trash/empty-all', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(emptyRes.status).toBe(200);
      expect(await emptyRes.json()).toMatchObject({ deleted: true, folders: 2, pages: 0 });
    });
  });
});
