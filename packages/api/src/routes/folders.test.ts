import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
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
  });

  describe('GET /api/folders/:id', () => {
    it('returns a specific folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Specific' });

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

    it('returns public folder children without a session', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id, { name: 'Public Folder' });
      const page = await createTestPage(owner.id, { parentId: folder.id, title: 'Child Page' });
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

      const res = await app.request(`/api/folders/${folder.id}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Public Folder');
      expect(body.linkPermission).toBe('view');
      expect(body.pages.some((p: { id: string }) => p.id === page.id)).toBe(true);
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

      const res = await app.request(`/api/folders/${child.id}`);

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
      const folder = await createTestFolder(user.id);

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
      const folder = await createTestFolder(user.id);
      await createTestPage(user.id, { parentId: folder.id });

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
