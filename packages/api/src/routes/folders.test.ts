import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

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
    it('returns folder tree for workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestFolder(user.workspaceId, user.id);

      const res = await app.request(`/api/folders/tree?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);
      await createTestFolder(ws.id, user1.id);

      const res = await app.request(`/api/folders/tree?workspaceId=${ws.id}`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
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
        body: JSON.stringify({ workspaceId: user.workspaceId, name: 'New Folder' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Folder');
    });

    it('creates a nested folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.workspaceId, user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ workspaceId: user.workspaceId, parentId: parent.id, name: 'Child' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.parentId).toBe(parent.id);
    });

    it('returns 400 when workspaceId is missing', async () => {
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
        body: JSON.stringify({ name: 'No Workspace' }),
      });

      expect(res.status).toBe(400);
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
          workspaceId: user.workspaceId,
          parentId: '00000000-0000-0000-0000-000000000000',
          name: 'Orphan',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session2.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ workspaceId: ws.id, name: 'Hacker' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/folders/:id', () => {
    it('returns a specific folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id, { name: 'Specific' });

      const res = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Specific');
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
  });

  describe('PATCH /api/folders/:id', () => {
    it('updates a folder name', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id, { name: 'Old' });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('prevents setting parent to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id);

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
      const parent = await createTestFolder(user.workspaceId, user.id, { name: 'Parent' });
      const child = await createTestFolder(user.workspaceId, user.id, {
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
      const folder = await createTestFolder(user.workspaceId, user.id, { name: 'Target' });
      const deleted = await createTestFolder(user.workspaceId, user.id, { name: 'Deleted' });

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

      expect(res.status).toBe(400);
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
      const folder = await createTestFolder(user.workspaceId, user.id, { name: 'Original' });

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

  describe('DELETE /api/folders/:id', () => {
    it('soft-deletes an empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('requires force flag for non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id);
      await createTestPage(user.workspaceId, user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.requiresForce).toBe(true);
    });

    it('force-deletes a non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.workspaceId, user.id);
      await createTestPage(user.workspaceId, user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
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
});
