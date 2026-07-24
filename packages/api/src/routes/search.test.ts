import { describe, expect, it } from 'vitest';
import { testQuery as query } from '../db/testQuery';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

describe('search API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/search?q=test');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/search?q=test', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/search', () => {
    it('returns search results for a query matching page titles', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestPage(user.id, { title: 'Searchable Note' });

      const res = await app.request(`/api/search?q=Searchable`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBeGreaterThanOrEqual(1);
      expect(body.results[0].title).toBe('Searchable Note');
    });

    it('returns empty results when query is empty', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/search?q=`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });

    it('returns empty results when no matches found', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestPage(user.id, { title: 'Apple' });

      const res = await app.request(`/api/search?q=Zebra`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });

    it('returns 400 for an invalid parent filter instead of leaking a database error', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/search?q=test&parentId=not-a-uuid', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'parentId must be a valid UUID or root' });
    });

    it('does not include deleted pages in results', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Deleted Note' });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/search?q=Deleted`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });

    it('does not expose private folder ancestry for a directly shared page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const recipientSession = await createTestSession(recipient.id);
      const privateRoot = await createTestFolder(owner.id, { name: 'Private Ancestor' });
      const privateParent = await createTestFolder(owner.id, {
        name: 'Private Parent',
        parentId: privateRoot.id,
      });
      await query("update folders set public_permission = 'view' where id = $1", [
        privateParent.id,
      ]);
      const sharedPage = await createTestPage(owner.id, {
        title: 'Direct Share Search Result',
        parentId: privateParent.id,
      });
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')`,
        [sharedPage.id, owner.id, recipient.id],
      );

      const res = await app.request('/api/search?q=Direct%20Share', {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toContainEqual(
        expect.objectContaining({
          id: sharedPage.id,
          breadcrumb: [],
        }),
      );
      expect(JSON.stringify(body)).not.toContain('Private Ancestor');
      expect(JSON.stringify(body)).not.toContain('Private Parent');

      const hiddenParentFilterRes = await app.request(
        `/api/search?q=Direct%20Share&parentId=${privateParent.id}`,
        { headers: { Cookie: recipientSession.Cookie } },
      );
      expect(hiddenParentFilterRes.status).toBe(200);
      expect(await hiddenParentFilterRes.json()).toEqual({ results: [] });

      const redactedRootFilterRes = await app.request(
        '/api/search?q=Direct%20Share&parentId=root',
        { headers: { Cookie: recipientSession.Cookie } },
      );
      expect(redactedRootFilterRes.status).toBe(200);
      expect((await redactedRootFilterRes.json()).results).toContainEqual(
        expect.objectContaining({ id: sharedPage.id }),
      );

      const recordedFolderAccess = await query<{ count: string }>(
        `select count(*)::text as count
         from folder_public_access_visits
         where folder_id = $1 and user_id = $2`,
        [privateParent.id, recipient.id],
      );
      expect(recordedFolderAccess.rows[0]?.count).toBe('0');

      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('folder', $1, $2, $3, 'view')`,
        [privateParent.id, owner.id, recipient.id],
      );

      const enumerableParentFilterRes = await app.request(
        `/api/search?q=Direct%20Share&parentId=${privateParent.id}`,
        { headers: { Cookie: recipientSession.Cookie } },
      );
      expect(enumerableParentFilterRes.status).toBe(200);
      expect((await enumerableParentFilterRes.json()).results).toContainEqual(
        expect.objectContaining({ id: sharedPage.id }),
      );
    });

    it('returns only the visible breadcrumb suffix for a folder-shared page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const recipientSession = await createTestSession(recipient.id);
      const privateRoot = await createTestFolder(owner.id, { name: 'Hidden Workspace Root' });
      const sharedRoot = await createTestFolder(owner.id, {
        name: 'Shared Folder',
        parentId: privateRoot.id,
      });
      const visibleChild = await createTestFolder(owner.id, {
        name: 'Visible Child',
        parentId: sharedRoot.id,
      });
      const sharedPage = await createTestPage(owner.id, {
        title: 'Folder Share Search Result',
        parentId: visibleChild.id,
      });
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('folder', $1, $2, $3, 'view')`,
        [sharedRoot.id, owner.id, recipient.id],
      );

      const res = await app.request('/api/search?q=Folder%20Share', {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toContainEqual(
        expect.objectContaining({
          id: sharedPage.id,
          breadcrumb: ['Shared Folder', 'Visible Child'],
        }),
      );
      expect(JSON.stringify(body)).not.toContain('Hidden Workspace Root');
    });
  });
});
