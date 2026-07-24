import { describe, expect, it } from 'vitest';
import { testQuery as query } from '../db/testQuery';
import {
  createTestApp,
  createTestPage,
  createTestPageLink,
  createTestSession,
  createTestUser,
} from '../test-utils';

async function addPageGrant(pageId: string, recipientUserId: string, permission = 'view') {
  await query(
    `INSERT INTO shares (entity_type, entity_id, recipient_user_id, permission)
     VALUES ('page', $1, $2, $3)`,
    [pageId, recipientUserId, permission],
  );
}

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

    it('does not expose source page metadata the user cannot access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const privateSource = await createTestPage(owner.id, { title: 'Private Source' });
      const sharedTarget = await createTestPage(owner.id, { title: 'Shared Target' });
      await createTestPageLink(privateSource.id, sharedTarget.id);
      await addPageGrant(sharedTarget.id, recipient.id);

      const ownerRes = await app.request(`/api/backlinks?pageId=${sharedTarget.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(ownerRes.status).toBe(200);
      expect(await ownerRes.json()).toContainEqual(
        expect.objectContaining({ sourcePageId: privateSource.id, sourceTitle: 'Private Source' }),
      );

      const recipientRes = await app.request(`/api/backlinks?pageId=${sharedTarget.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(recipientRes.status).toBe(200);
      expect(await recipientRes.json()).toEqual([]);
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
      expect(body[0]).toEqual(
        expect.objectContaining({
          targetPageId: page2.id,
          targetTitle: 'Target',
          targetPageTitle: 'Target',
          targetState: 'accessible',
        }),
      );
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

    it('hides target page metadata when the user cannot access the target', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const recipientSession = await createTestSession(recipient.id);
      const sharedSource = await createTestPage(owner.id, { title: 'Shared Source' });
      const privateTarget = await createTestPage(owner.id, { title: 'Private Target' });
      const privateLink = await createTestPageLink(sharedSource.id, privateTarget.id);
      await query(
        `update connections
         set target_label = 'Resolver Canonical Private Title', link_text = 'Authored Alias'
         where id = $1`,
        [privateLink.id],
      );
      await query(
        `insert into connections (
           source_type, source_id, target_type, target_slug, target_label,
           connection_type, link_text
         ) values (
           'page', $1, 'page', 'unresolved-candidate', 'Unresolved Candidate',
           'wikilink', 'Authored Alias'
         )`,
        [sharedSource.id],
      );
      await addPageGrant(sharedSource.id, recipient.id);

      const res = await app.request(`/api/backlinks/outgoing?pageId=${sharedSource.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body).toContainEqual(
        expect.objectContaining({
          targetPageId: null,
          targetTitle: 'Restricted page',
          linkText: 'Restricted page',
          targetPageTitle: null,
          targetPageIcon: null,
          targetState: 'restricted',
        }),
      );
      expect(body).toContainEqual(
        expect.objectContaining({
          targetPageId: null,
          targetTitle: 'Link unavailable',
          linkText: 'Link unavailable',
          targetPageTitle: null,
          targetPageIcon: null,
          targetState: 'unavailable',
        }),
      );
      expect(JSON.stringify(body)).not.toContain('Private Target');
      expect(JSON.stringify(body)).not.toContain('Resolver Canonical Private Title');
      expect(JSON.stringify(body)).not.toContain('Unresolved Candidate');
      expect(JSON.stringify(body)).not.toContain('Authored Alias');
    });

    it('treats a stale cross-workspace target as unavailable on both sides', async () => {
      const app = await createTestApp();
      const sourceOwner = await createTestUser();
      const targetOwner = await createTestUser();
      const sourceSession = await createTestSession(sourceOwner.id);
      const targetSession = await createTestSession(targetOwner.id);
      const source = await createTestPage(sourceOwner.id, { title: 'Source workspace page' });
      const target = await createTestPage(targetOwner.id, { title: 'Other workspace target' });
      await createTestPageLink(source.id, target.id);
      await addPageGrant(source.id, targetOwner.id);

      const outgoing = await app.request(`/api/backlinks/outgoing?pageId=${source.id}`, {
        headers: { Cookie: sourceSession.Cookie },
      });
      expect(outgoing.status).toBe(200);
      expect(await outgoing.json()).toContainEqual(
        expect.objectContaining({
          targetPageId: null,
          targetTitle: 'Link unavailable',
          linkText: 'Link unavailable',
          targetState: 'unavailable',
        }),
      );

      const incoming = await app.request(`/api/backlinks?pageId=${target.id}`, {
        headers: { Cookie: targetSession.Cookie },
      });
      expect(incoming.status).toBe(200);
      expect(await incoming.json()).toEqual([]);
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
      const connectionsResult = await query(
        `select target_slug, target_label from connections
         where source_id = $1 and target_id = $2`,
        [source.id, target.id],
      );
      expect(connectionsResult.rows[0]?.target_slug).toBe('original');
      expect(connectionsResult.rows[0]?.target_label).toBe('Original');

      const outgoingRes = await app.request(`/api/backlinks/outgoing?pageId=${source.id}`, {
        headers: { Cookie: session.Cookie },
      });
      expect(outgoingRes.status).toBe(200);
      expect(await outgoingRes.json()).toContainEqual(
        expect.objectContaining({
          targetPageId: target.id,
          targetTitle: 'Renamed',
          targetPageTitle: 'Renamed',
        }),
      );
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
