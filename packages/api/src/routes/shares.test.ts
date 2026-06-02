import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';

describe('shares API', () => {
  it('invites an existing user to a page and grants page access', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const ownerSession = await createTestSession(owner.id);
    const recipientSession = await createTestSession(recipient.id);
    const page = await createTestPage(owner.id, { title: 'Shared plan' });

    const inviteRes = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerSession.Cookie,
      },
      body: JSON.stringify({ email: recipient.email, permission: 'view' }),
    });

    expect(inviteRes.status).toBe(200);

    const pageRes = await app.request(`/api/pages/${page.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(pageRes.status).toBe(200);
    expect((await pageRes.json()).title).toBe('Shared plan');

    const sharedRes = await app.request('/api/shares/with-me', {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(sharedRes.status).toBe(200);
    const sharedItems = (await sharedRes.json()) as Array<{ title: string; entityType: string }>;
    expect(sharedItems).toContainEqual(
      expect.objectContaining({ title: 'Shared plan', entityType: 'page' }),
    );
  });

  it('creates and disables a public page link', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const page = await createTestPage(owner.id, { title: 'Public plan' });

    const _linkRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.Cookie,
      },
      body: JSON.stringify({ permission: 'view' }),
    });
    expect(_linkRes.status).toBe(200);
    const _link = (await _linkRes.json()) as { token: string };

    const publicRes = await app.request(`/api/pages/${page.id}`);
    expect(publicRes.status).toBe(200);
    expect((await publicRes.json()).title).toBe('Public plan');

    const disableRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.Cookie,
      },
      body: JSON.stringify({ permission: 'private' }),
    });
    expect(disableRes.status).toBe(200);

    const disabledPublicRes = await app.request(`/api/pages/${page.id}`);
    expect(disabledPublicRes.status).toBe(404);
  });

  it('merges invite and link access for the same user', async () => {
    const app = await createTestApp();
    const owner = await createTestUser({ name: 'Owner' });
    const recipient = await createTestUser({ name: 'Recipient' });
    const ownerSession = await createTestSession(owner.id);
    const recipientSession = await createTestSession(recipient.id);
    const page = await createTestPage(owner.id, { title: 'Merged access' });

    const inviteRes = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerSession.Cookie,
      },
      body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
    });
    expect(inviteRes.status).toBe(200);

    const _linkRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerSession.Cookie,
      },
      body: JSON.stringify({ permission: 'view' }),
    });
    const accessRes = await app.request(`/api/pages/${page.id}/access`, {
      method: 'POST',
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(accessRes.status).toBe(200);

    const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
      headers: { Cookie: ownerSession.Cookie },
    });
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      accessors: Array<{
        name: string | null;
        source: string;
        permission: string;
        isOwner: boolean;
      }>;
    };
    expect(summary.accessors[0]).toEqual(
      expect.objectContaining({
        name: 'Owner',
        source: 'owner',
        permission: 'edit',
        isOwner: true,
      }),
    );
    expect(summary.accessors).toContainEqual(
      expect.objectContaining({
        name: 'Recipient',
        permission: 'edit',
        isOwner: false,
      }),
    );
  });

  describe('workspace membership (E2E)', () => {
    it('grants workspace member access to owners page via HTTP', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const memberSession = await createTestSession(member.id);
      const page = await createTestPage(owner.id, { title: 'Workspace page' });
      await createTestWorkspaceMember(owner.id, member.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: memberSession.Cookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { title: string };
      expect(data.title).toBe('Workspace page');
    });

    it('denies workspace member access to page inside restricted folder via HTTP', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const memberSession = await createTestSession(member.id);
      const folder = await createTestFolder(owner.id, { name: 'Restricted' });
      await pool.query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folder.id]);
      const page = await createTestPage(owner.id, {
        title: 'Secret page',
        parentId: folder.id,
      });
      await createTestWorkspaceMember(owner.id, member.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: memberSession.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('allows workspace member to list owners pages in page tree', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const memberSession = await createTestSession(member.id);
      await createTestPage(owner.id, { title: 'Owner page 1' });
      await createTestPage(owner.id, { title: 'Owner page 2' });
      await createTestWorkspaceMember(owner.id, member.id);

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: memberSession.Cookie },
      });

      expect(res.status).toBe(200);
      const pages = (await res.json()) as Array<{ title: string }>;
      expect(pages).toContainEqual(expect.objectContaining({ title: 'Owner page 1' }));
      expect(pages).toContainEqual(expect.objectContaining({ title: 'Owner page 2' }));
    });

    it('excludes pages inside restricted folder from workspace members page tree', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const memberSession = await createTestSession(member.id);
      const restrictedFolder = await createTestFolder(owner.id, { name: 'Secret' });
      await pool.query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [
        restrictedFolder.id,
      ]);
      await createTestPage(owner.id, {
        title: 'Public page',
      });
      await createTestPage(owner.id, {
        title: 'Secret page',
        parentId: restrictedFolder.id,
      });
      await createTestWorkspaceMember(owner.id, member.id);

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: memberSession.Cookie },
      });

      expect(res.status).toBe(200);
      const pages = (await res.json()) as Array<{ title: string }>;
      expect(pages).toContainEqual(expect.objectContaining({ title: 'Public page' }));
      expect(pages).not.toContainEqual(expect.objectContaining({ title: 'Secret page' }));
    });
  });
});
