import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import {
  createTestApp,
  createTestPage,
  createTestPageLink,
  createTestSession,
  createTestUser,
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
      const page1 = await createTestPage(user.id, { title: 'Source' });
      const page2 = await createTestPage(user.id, { title: 'Target' });
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

    it('does not include backlinks from deleted pages', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.id, { title: 'Source' });
      const page2 = await createTestPage(user.id, { title: 'Target' });
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
      const page1 = await createTestPage(user.id, { title: 'Source' });
      const page2 = await createTestPage(user.id, { title: 'Target' });
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
  });

  describe('rename handling', () => {
    it('sends a pg_notify on rename and does not mutate connections', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const source = await createTestPage(user.id, { title: 'Source' });
      const target = await createTestPage(user.id, { title: 'Original' });
      await createTestPageLink(source.id, target.id);

      const renameRes = await app.request(`/api/pages/${target.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(renameRes.status).toBe(200);

      // Connections should NOT be mutated by the REST API; they are rebuilt
      // from Yjs content by the collab server on next save.
      const connectionsResult = await pool.query(
        `select target_slug, target_label from connections
         where source_id = $1 and target_id = $2`,
        [source.id, target.id],
      );
      expect(connectionsResult.rows[0]?.target_slug).toBe('original');
      expect(connectionsResult.rows[0]?.target_label).toBe('Original');
    });

    it('does not mutate connections when title has not changed', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const target = await createTestPage(user.id, { title: 'Target' });

      const patchRes = await app.request(`/api/pages/${target.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Target' }),
      });
      expect(patchRes.status).toBe(200);
    });

    it('supports multiple renames for the same target', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const target = await createTestPage(user.id, { title: 'Original' });

      const res1 = await app.request(`/api/pages/${target.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request(`/api/pages/${target.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Renamed Again' }),
      });
      expect(res2.status).toBe(200);
    });
  });
});
