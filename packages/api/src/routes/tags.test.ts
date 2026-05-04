import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestTag,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

describe('tags API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/tags');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/tags', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/tags', () => {
    it('lists tags for a workspace with page counts', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestTag(user.workspaceId, { name: 'todo' });

      const res = await app.request(`/api/tags?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].name).toBe('todo');
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/tags', {
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
      await createTestTag(ws.id, { name: 'secret' });

      const res = await app.request(`/api/tags?workspaceId=${ws.id}`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/tags/pages', () => {
    it('returns pages for a tag', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.workspaceId, user.id);
      const tag = await createTestTag(user.workspaceId, { name: 'review' });

      await pool.query('insert into page_tags (page_id, tag_id) values ($1, $2)', [
        page.id,
        tag.id,
      ]);

      const res = await app.request(
        `/api/tags/pages?workspaceId=${user.workspaceId}&tagId=${tag.id}`,
        { headers: { Cookie: session.Cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const tag = await createTestTag(user.workspaceId);

      const res = await app.request(`/api/tags/pages?tagId=${tag.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when tagId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/tags/pages?workspaceId=${user.workspaceId}`, {
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
      const tag = await createTestTag(ws.id);

      const res = await app.request(`/api/tags/pages?workspaceId=${ws.id}&tagId=${tag.id}`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });
});
