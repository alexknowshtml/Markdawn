import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

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
    it('returns 400 when workspaceId is missing', async () => {
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
        body: JSON.stringify({ title: 'Test' }),
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('workspaceId is required');
    });

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
          workspaceId: user.workspaceId,
          title: 'My Test Page',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('My Test Page');
      expect(body.workspaceId).toBe(user.workspaceId);
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
          workspaceId: user.workspaceId,
          title: 'Orphan Page',
          parentId: '00000000-0000-0000-0000-000000000000',
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/pages/tree', () => {
    it('returns pages for the workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      await createTestPage(user.workspaceId, user.id, { title: 'Page 1' });
      await createTestPage(user.workspaceId, user.id, { title: 'Page 2' });

      const res = await app.request(`/api/pages/tree?workspaceId=${user.workspaceId}`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBe(2);
      expect(body.map((p: { title: string }) => p.title).sort()).toEqual(['Page 1', 'Page 2']);
    });

    it('forbids access to workspace the user does not belong to', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const other = await createTestUser();

      const res = await app.request(`/api/pages/tree?workspaceId=${other.workspaceId}`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/tree', {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/pages/trash', () => {
    it('lists trashed pages for the workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id, { title: 'To Delete' });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/trash?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('returns 400 without workspaceId', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/trash', {
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const other = await createTestUser();

      const res = await app.request(`/api/pages/trash?workspaceId=${other.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/pages/trash/empty-all', () => {
    it('empties all trashed pages in workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);
      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/trash/empty-all?workspaceId=${user.workspaceId}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
      expect(body.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/pages/recent', () => {
    it('returns recent pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/recent?workspaceId=${user.workspaceId}`, {
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

      const res = await app.request(`/api/pages/recent?workspaceId=${user.workspaceId}&limit=0`, {
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/pages/:id/restore', () => {
    it('restores a soft-deleted page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const treeRes = await app.request(`/api/pages/tree?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const tree = await treeRes.json();
      expect(tree.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });
  });

  describe('PATCH /api/pages/:id/move', () => {
    it('moves a page to a different parent', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id, { title: 'Movable' });

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

    it('prevents moving page to itself', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

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
  });

  describe('GET /api/pages/:id/export/markdown', () => {
    it('exports page content as markdown', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id, { title: 'Export' });

      const res = await app.request(`/api/pages/${page.id}/export/markdown`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('Export.md');
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
      const page = await createTestPage(user.workspaceId, user.id, { title: 'Import' });

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
    });

    it('returns 415 for unsupported content type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

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
      const page = await createTestPage(user.workspaceId, user.id);

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
      const page = await createTestPage(user.workspaceId, user.id, { title: 'Original' });

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
    it('permanently deletes a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      const res = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
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
      const page = await createTestPage(user.workspaceId, user.id, {
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
      const page = await createTestPage(user.workspaceId, user.id, {
        title: 'Original',
      });

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
    });

    it('returns 400 when setting parentId to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

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
      const page = await createTestPage(user.workspaceId, user.id);

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
      const page = await createTestPage(user.workspaceId, user.id);

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
      const page = await createTestPage(user.workspaceId, user.id);

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
});
