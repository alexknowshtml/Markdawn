import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

async function createTagConnection(pageId: string, tag: string) {
  await query(
    `insert into connections (
       source_type, source_id, target_type, target_slug,
       target_label, connection_type, link_text, occurrence_count, updated_at
     )
     values ('page', $1, 'tag', $2, $2, 'tag', $2, 1, now())`,
    [pageId, `#${tag}`],
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
    it('lists tags with page counts', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      await createTagConnection(page.id, 'todo');

      const res = await app.request('/api/tags', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].name).toBe('todo');
    });
  });

  describe('GET /api/tags/pages', () => {
    it('returns pages for a tag', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      await createTagConnection(page.id, 'review');

      const res = await app.request('/api/tags/pages?tagId=%23review', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });

    it('uses current access instead of the page creator', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const formerEditor = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const editorSession = await createTestSession(formerEditor.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(formerEditor.id, { parentId: folder.id, title: 'Revoked' });
      await createTagConnection(page.id, 'private');

      const ownerRes = await app.request('/api/tags/pages?tagId=%23private', {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(await ownerRes.json()).toContainEqual(expect.objectContaining({ id: page.id }));

      const editorRes = await app.request('/api/tags/pages?tagId=%23private', {
        headers: { Cookie: editorSession.Cookie },
      });
      expect(await editorRes.json()).not.toContainEqual(expect.objectContaining({ id: page.id }));
    });

    it('returns 400 when tagId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/tags/pages', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });
  });
});
