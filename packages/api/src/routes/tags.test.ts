import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

async function createTagConnection(workspaceId: string, pageId: string, tag: string) {
  await pool.query(
    `insert into connections (
       workspace_id, source_type, source_id, target_type, target_slug,
       target_label, connection_type, link_text, occurrence_count, updated_at
     )
     values ($1, 'page', $2, 'tag', $3, $3, 'tag', $3, 1, now())`,
    [workspaceId, pageId, `#${tag}`],
  );
}

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
      const page = await createTestPage(user.workspaceId, user.id);
      await createTagConnection(user.workspaceId, page.id, 'todo');

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
      const page = await createTestPage(ws.id, user1.id);
      await createTagConnection(ws.id, page.id, 'secret');

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
      await createTagConnection(user.workspaceId, page.id, 'review');

      const res = await app.request(
        `/api/tags/pages?workspaceId=${user.workspaceId}&tagId=%23review`,
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
      const res = await app.request('/api/tags/pages?tagId=anything', {
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
      const res = await app.request(`/api/tags/pages?workspaceId=${ws.id}&tagId=anything`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });
});
