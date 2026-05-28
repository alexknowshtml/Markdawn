import { describe, expect, it } from 'vitest';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';

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
      accessors: Array<{ name: string | null; source: string; permission: string }>;
    };
    expect(summary.accessors).toContainEqual(
      expect.objectContaining({
        name: 'Recipient',
        source: 'Email + Link',
        permission: 'edit',
      }),
    );
  });
});
