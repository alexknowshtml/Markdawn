import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';
import { pool } from '../db/connection';

describe('public sharing API', () => {
  describe('auth guard', () => {
    it('returns 401 on share endpoint without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/share', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('public access (no auth required)', () => {
    it('returns 404 for non-existent public token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/public/non-existent-token');
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
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/non-existent/share', {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(404);
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
  });
});
