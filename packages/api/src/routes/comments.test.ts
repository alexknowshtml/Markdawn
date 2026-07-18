import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestComment,
  createTestPage,
  createTestReply,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
  enableTestPagePublicAccess,
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

    it('does not expose comment or reply emails to a signed-in public visitor', async () => {
      const app = await createTestApp();
      const owner = await createTestUser({
        email: 'private-comment-author@example.com',
        name: 'Comment Author',
      });
      const replyAuthor = await createTestUser({
        email: 'private-reply-author@example.com',
        name: 'Reply Author',
      });
      const visitor = await createTestUser();
      const visitorSession = await createTestSession(visitor.id);
      const page = await createTestPage(owner.id, { title: 'Public comments' });
      const comment = await createTestComment(page.id, owner.id);
      const reply = await createTestReply(comment.id, replyAuthor.id);
      await enableTestPagePublicAccess(page.id);

      const accessRes = await app.request(`/api/pages/${page.id}/access`, {
        method: 'POST',
        headers: { Cookie: visitorSession.Cookie },
      });
      expect(accessRes.status).toBe(200);

      const res = await app.request(`/api/pages/${page.id}/comments`, {
        headers: { Cookie: visitorSession.Cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        userId: string;
        user: Record<string, unknown>;
        replies: Array<{ id: string; userId: string; user: Record<string, unknown> }>;
      }>;

      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        userId: owner.id,
        user: { id: owner.id, name: owner.name, avatarUrl: null },
        replies: [
          {
            id: reply.id,
            userId: replyAuthor.id,
            user: { id: replyAuthor.id, name: replyAuthor.name, avatarUrl: null },
          },
        ],
      });
      expect(Object.keys(body[0]?.user ?? {}).sort()).toEqual(['avatarUrl', 'id', 'name']);
      expect(Object.keys(body[0]?.replies[0]?.user ?? {}).sort()).toEqual([
        'avatarUrl',
        'id',
        'name',
      ]);
      const encoded = JSON.stringify(body);
      expect(encoded).not.toContain(owner.email);
      expect(encoded).not.toContain(replyAuthor.email);
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
      expect(body.user).not.toHaveProperty('email');
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
      expect(body.user).not.toHaveProperty('email');
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

  describe('guest comments', () => {
    it('persists a stable guest author on publicly editable pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      await query("update pages set public_permission = 'edit' where id = $1", [page.id]);
      const guestId = crypto.randomUUID();
      const headers = {
        Cookie: `markdawn_anon_id=${guestId}`,
        'Content-Type': 'application/json',
      };

      const createResponse = await app.request(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'Guest comment' }),
      });
      expect(createResponse.status).toBe(200);
      const comment = (await createResponse.json()) as {
        id: string;
        userId: string | null;
        isOwn: boolean;
        user: { id: string | null; name: string };
      };
      expect(comment.userId).toBeNull();
      expect(comment.isOwn).toBe(true);
      expect(comment.user).toEqual({ id: null, name: expect.any(String), avatarUrl: null });

      const replyResponse = await app.request(
        `/api/pages/${page.id}/comments/${comment.id}/replies`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: 'Guest reply' }),
        },
      );
      expect(replyResponse.status).toBe(200);
      expect(await replyResponse.json()).toEqual(
        expect.objectContaining({ userId: null, isOwn: true, content: 'Guest reply' }),
      );

      const listResponse = await app.request(`/api/pages/${page.id}/comments`, { headers });
      expect(listResponse.status).toBe(200);
      const listedComments = await listResponse.json();
      expect(listedComments).toEqual([
        expect.objectContaining({
          id: comment.id,
          userId: null,
          isOwn: true,
          replies: [expect.objectContaining({ userId: null, isOwn: true })],
        }),
      ]);
      expect(JSON.stringify(listedComments)).not.toContain(guestId);

      const identity = await query<{ name: string }>(
        'select name from guest_identities where id = $1',
        [guestId],
      );
      expect(identity.rows[0]?.name).toBe(comment.user.name);
    });

    it('lets a guest mutate only their own comment', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      await query("update pages set public_permission = 'edit' where id = $1", [page.id]);
      const authorId = crypto.randomUUID();
      const authorHeaders = {
        Cookie: `markdawn_anon_id=${authorId}`,
        'Content-Type': 'application/json',
      };
      const createResponse = await app.request(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers: authorHeaders,
        body: JSON.stringify({ content: 'Original' }),
      });
      const comment = (await createResponse.json()) as { id: string };

      const ownEdit = await app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
        method: 'PATCH',
        headers: authorHeaders,
        body: JSON.stringify({ content: 'Updated' }),
      });
      expect(ownEdit.status).toBe(200);

      const otherEdit = await app.request(`/api/pages/${page.id}/comments/${comment.id}`, {
        method: 'PATCH',
        headers: {
          Cookie: `markdawn_anon_id=${crypto.randomUUID()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Stolen' }),
      });
      expect(otherEdit.status).toBe(403);
    });
  });
});
