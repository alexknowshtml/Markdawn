import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestComment,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';

describe('comments API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/comments');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/pages/:pageId/comments', () => {
    it('lists comments for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      await createTestComment(page.id, user.id);

      const res = await app.request(`/api/pages/${page.id}/comments`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/comments', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pages/:pageId/comments', () => {
    it('creates a comment on a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ content: 'Great page!' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('Great page!');
    });

    it('allows viewers to read comments but denies comment mutations', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id);
      const comment = await createTestComment(page.id, viewer.id);
      await createTestWorkspaceMember(owner.id, viewer.id, 'viewer');
      const headers = {
        'Content-Type': 'application/json',
        Cookie: session.Cookie,
        Origin: 'http://localhost:5173',
      };

      const listResponse = await app.request(`/api/pages/${page.id}/comments`, { headers });
      expect(listResponse.status).toBe(200);

      const mutationResponses = await Promise.all([
        app.request(`/api/pages/${page.id}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'Viewer comment' }),
        }),
        app.request(`/api/pages/${page.id}/comments/${comment.id}/replies`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'Viewer reply' }),
        }),
        app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ resolved: true }),
        }),
        app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
          method: 'DELETE',
          headers,
        }),
      ]);

      expect(mutationResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    });

    it('returns 400 when content is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/pages/:pageId/comments/:commentId/replies', () => {
    it('adds a reply to a comment', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const comment = await createTestComment(page.id, user.id);

      const res = await app.request(`/api/pages/${page.id}/comments/${comment.id}/replies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ content: 'A reply' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('A reply');
    });
  });

  describe('PATCH /api/pages/:pageId/comments/:commentId', () => {
    it('resolves a comment', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const comment = await createTestComment(page.id, user.id);

      const res = await app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ resolved: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resolved).toBe(true);
    });
  });

  describe('DELETE /api/pages/:pageId/comments/:commentId', () => {
    it('deletes a comment', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const comment = await createTestComment(page.id, user.id);

      const res = await app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
    });

    it('returns 403 when deleting another user comment', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const page = await createTestPage(user1.id);
      const comment = await createTestComment(page.id, user1.id);

      const res = await app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
        method: 'DELETE',
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });
  });
});
