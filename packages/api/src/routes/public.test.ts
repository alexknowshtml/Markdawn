import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

describe('public sharing API', () => {
  describe('auth guard', () => {
    it('returns 401 on share endpoint without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/share', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token on share endpoint', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/share', {
        method: 'POST',
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('public access (no auth required)', () => {
    it('returns 404 for non-existent public token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/public/non-existent-token');
      expect(res.status).toBe(404);
    });

    it('returns page content for a valid public token', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id, { title: 'Public Page' });

      const shareRes = await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const { publicToken } = await shareRes.json();

      const res = await app.request(`/api/public/${publicToken}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Public Page');
    });

    it('returns 404 for a private page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const page = await createTestPage(user.workspaceId, user.id);
      const token = crypto.randomUUID();

      await pool.query('update pages set public_token = $1 where id = $2', [token, page.id]);

      const res = await app.request(`/api/public/${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pages/:pageId/share', () => {
    it('enables public sharing for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      const res = await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isPublic).toBe(true);
      expect(body.publicToken).toBeTruthy();
      expect(body.shareUrl).toMatch(/^\/public\//);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/share', {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);
      const page = await createTestPage(ws.id, user1.id);

      const res = await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: { Cookie: session2.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(403);
    });

    it('reuses existing public token when re-sharing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      const res1 = await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const { publicToken } = await res1.json();

      const res2 = await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const body2 = await res2.json();

      expect(body2.publicToken).toBe(publicToken);
    });
  });

  describe('DELETE /api/pages/:pageId/share', () => {
    it('disables public sharing for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);

      await app.request(`/api/pages/${page.id}/share`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/${page.id}/share`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isPublic).toBe(false);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/share', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);
      const page = await createTestPage(ws.id, user1.id);

      const res = await app.request(`/api/pages/${page.id}/share`, {
        method: 'DELETE',
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });
});
