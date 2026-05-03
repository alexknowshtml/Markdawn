import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestSession,
  createTestTag,
  createTestUser,
} from '../test-utils';

describe('tags API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/tags');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/tags', () => {
    it('lists tags for a workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestTag(user.workspaceId);

      const res = await app.request(`/api/tags?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('GET /api/tags/pages', () => {
    it('returns pages for a tag', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/tags/pages?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
    });
  });
});

describe('search API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/search?q=test');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/search', () => {
    it('returns search results for a query', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(
        `/api/search?q=test&workspaceId=${user.workspaceId}`,
        { headers: { Cookie: session.Cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 400 when query is empty', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(
        `/api/search?q=&workspaceId=${user.workspaceId}`,
        { headers: { Cookie: session.Cookie } },
      );

      expect(res.status).toBe(400);
    });
  });
});
