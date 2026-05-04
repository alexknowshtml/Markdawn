import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPage,
  createTestPageLink,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

describe('backlinks API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/backlinks?pageId=some-id');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/backlinks?pageId=some-id', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/backlinks', () => {
    it('returns incoming backlinks for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.workspaceId, user.id, { title: 'Source' });
      const page2 = await createTestPage(user.workspaceId, user.id, { title: 'Target' });
      await createTestPageLink(page1.id, page2.id);

      const res = await app.request(`/api/backlinks?pageId=${page2.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].sourcePageId).toBe(page1.id);
    });

    it('returns 400 when pageId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/backlinks', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 when user is not a workspace member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);
      const page = await createTestPage(ws.id, user1.id);

      const res = await app.request(`/api/backlinks?pageId=${page.id}`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('does not include backlinks from deleted pages', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.workspaceId, user.id, { title: 'Source' });
      const page2 = await createTestPage(user.workspaceId, user.id, { title: 'Target' });
      await createTestPageLink(page1.id, page2.id);

      await app.request(`/api/pages/${page1.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/backlinks?pageId=${page2.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBe(0);
    });
  });

  describe('GET /api/backlinks/outgoing', () => {
    it('returns outgoing links from a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.workspaceId, user.id, { title: 'Source' });
      const page2 = await createTestPage(user.workspaceId, user.id, { title: 'Target' });
      await createTestPageLink(page1.id, page2.id);

      const res = await app.request(`/api/backlinks/outgoing?pageId=${page1.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].targetPageId).toBe(page2.id);
    });

    it('returns 400 when pageId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/backlinks/outgoing', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 when user is not a workspace member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);
      const page = await createTestPage(ws.id, user1.id);

      const res = await app.request(`/api/backlinks/outgoing?pageId=${page.id}`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });
});
