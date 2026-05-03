import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestTemplate,
  createTestUser,
  createTestVersion,
} from '../test-utils';

describe('templates API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/templates');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/templates', () => {
    it('lists templates for a workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestTemplate(user.workspaceId, user.id);

      const res = await app.request(`/api/templates?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('POST /api/templates', () => {
    it('creates a template', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          workspaceId: user.workspaceId,
          name: 'My Template',
          content: '# Content',
        }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /api/templates/:id', () => {
    it('deletes a template', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const tmpl = await createTestTemplate(user.workspaceId, user.id);

      const res = await app.request(`/api/templates/${tmpl.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
    });
  });
});

describe('versions API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/versions');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/pages/:pageId/versions', () => {
    it('lists versions for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);
      await createTestVersion(page.id, user.id);

      const res = await app.request(`/api/pages/${page.id}/versions`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('POST /api/pages/:pageId/versions', () => {
    it('creates a version snapshot', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      const res = await app.request(`/api/pages/${page.id}/versions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'v1' }),
      });

      expect(res.status).toBe(201);
    });
  });
});
