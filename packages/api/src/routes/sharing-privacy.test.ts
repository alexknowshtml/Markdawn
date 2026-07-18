import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

type Presence = {
  presenceId: string;
  name: string | null;
  avatarUrl: string | null;
};

function expectPresenceOnly(value: unknown): asserts value is Presence[] {
  expect(Array.isArray(value)).toBe(true);
  for (const presence of value as unknown[]) {
    expect(presence).toBeTypeOf('object');
    expect(Object.keys(presence as Record<string, unknown>).sort()).toEqual([
      'avatarUrl',
      'name',
      'presenceId',
    ]);
  }
}

describe('sharing identity privacy', () => {
  it('returns only aggregate presence to direct and inherited non-admin viewers', async () => {
    const app = await createTestApp();
    const owner = await createTestUser({ name: 'Owner Visible Name' });
    const directEditor = await createTestUser({ name: 'Direct Editor Name' });
    const inheritedViewer = await createTestUser({ name: 'Inherited Viewer Name' });
    const ownerSession = await createTestSession(owner.id);
    const editorSession = await createTestSession(directEditor.id);
    const viewerSession = await createTestSession(inheritedViewer.id);
    const folder = await createTestFolder(owner.id, { name: 'Private topology name' });
    const page = await createTestPage(owner.id, {
      title: 'Privacy page',
      parentId: folder.id,
    });

    const directInvite = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
      body: JSON.stringify({ email: directEditor.email, permission: 'edit' }),
    });
    expect(directInvite.status).toBe(200);
    const inheritedInvite = await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
      body: JSON.stringify({ email: inheritedViewer.email, permission: 'view' }),
    });
    expect(inheritedInvite.status).toBe(200);

    for (const [session, permission] of [
      [editorSession.Cookie, 'edit'],
      [viewerSession.Cookie, 'view'],
    ] as const) {
      const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: session },
      });
      expect(summaryRes.status).toBe(200);
      const summary = (await summaryRes.json()) as Record<string, unknown> & {
        entity: { ownerId: string | null };
        link: { token: string | null; url: string | null };
        userPermission: string;
      };
      expect(summary).toMatchObject({
        visibility: 'limited',
        userPermission: permission,
        entity: { ownerId: null },
        link: { token: null, url: null },
        invites: [],
        accessors: [],
        accessSources: [],
        inheritedLinks: [],
        permissionDetails: [],
        inheritedAccessors: [],
      });
      const encoded = JSON.stringify(summary);
      expect(encoded).not.toContain(owner.email);
      expect(encoded).not.toContain(directEditor.email);
      expect(encoded).not.toContain(inheritedViewer.email);
      expect(encoded).not.toContain(owner.id);
      expect(encoded).not.toContain(directEditor.id);
      expect(encoded).not.toContain(inheritedViewer.id);
      expect(encoded).not.toContain('Private topology name');
    }

    const pagePresenceRes = await app.request(
      `/api/shares/pages/collaborators?pageIds=${page.id}`,
      { headers: { Cookie: editorSession.Cookie } },
    );
    expect(pagePresenceRes.status).toBe(200);
    const pagePresence = (await pagePresenceRes.json()) as Record<string, unknown>;
    expectPresenceOnly(pagePresence[page.id]);

    const folderPresenceRes = await app.request(
      `/api/shares/folders/collaborators?folderIds=${folder.id}`,
      { headers: { Cookie: viewerSession.Cookie } },
    );
    expect(folderPresenceRes.status).toBe(200);
    const folderPresence = (await folderPresenceRes.json()) as Record<string, unknown>;
    expectPresenceOnly(folderPresence[folder.id]);
  });

  it('does not expose identities or topology to a signed-in public-link visitor', async () => {
    const app = await createTestApp();
    const owner = await createTestUser({ name: 'Public Owner Name' });
    const collaborator = await createTestUser({ name: 'Hidden Collaborator Name' });
    const visitor = await createTestUser({ name: 'Public Visitor Name' });
    const ownerSession = await createTestSession(owner.id);
    const visitorSession = await createTestSession(visitor.id);
    const page = await createTestPage(owner.id, { title: 'Public privacy page' });

    await app.request(`/api/shares/entity/page/${page.id}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
      body: JSON.stringify({ email: collaborator.email, permission: 'view' }),
    });
    const linkRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
      body: JSON.stringify({ permission: 'view' }),
    });
    expect(linkRes.status).toBe(200);
    const link = (await linkRes.json()) as { token: string };
    const accessRes = await app.request(`/api/pages/${page.id}/access`, {
      method: 'POST',
      headers: { Cookie: visitorSession.Cookie, 'x-share-token': link.token },
    });
    expect(accessRes.status).toBe(200);

    const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
      headers: { Cookie: visitorSession.Cookie },
    });
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      visibility: 'limited',
      userPermission: 'view',
      link: { token: null, url: null },
      accessors: [],
      accessSources: [],
      inheritedLinks: [],
    });
    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain(owner.email);
    expect(encoded).not.toContain(collaborator.email);
    expect(encoded).not.toContain(owner.id);
    expect(encoded).not.toContain(collaborator.id);
    expect(encoded).not.toContain(link.token);

    const presenceRes = await app.request(`/api/shares/pages/collaborators?pageIds=${page.id}`, {
      headers: { Cookie: visitorSession.Cookie },
    });
    expect(presenceRes.status).toBe(200);
    const presence = (await presenceRes.json()) as Record<string, unknown>;
    expectPresenceOnly(presence[page.id]);
    expect(JSON.stringify(presence)).not.toContain(collaborator.email);
  });

  it('keeps full management identities available to admins', async () => {
    const app = await createTestApp();
    const owner = await createTestUser({ name: 'Admin Owner' });
    const recipient = await createTestUser({ name: 'Managed Recipient' });
    const ownerSession = await createTestSession(owner.id);
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    await app.request(`/api/shares/entity/page/${page.id}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
      body: JSON.stringify({ email: recipient.email, permission: 'view' }),
    });

    const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
      headers: { Cookie: ownerSession.Cookie },
    });
    const summary = (await summaryRes.json()) as {
      visibility: string;
      invites: Array<{ id: string; recipientEmail: string }>;
      accessSources: Array<{ userId: string; shareId: string | null; permission: string }>;
    };
    expect(summary.visibility).toBe('full');
    expect(summary.invites).toContainEqual(
      expect.objectContaining({ id: expect.any(String), recipientEmail: recipient.email }),
    );
    expect(summary.accessSources).toContainEqual(
      expect.objectContaining({
        userId: recipient.id,
        shareId: expect.any(String),
        permission: 'view',
      }),
    );

    const pageCollaboratorsRes = await app.request(
      `/api/shares/pages/collaborators?pageIds=${page.id}`,
      { headers: { Cookie: ownerSession.Cookie } },
    );
    const pageCollaborators = (await pageCollaboratorsRes.json()) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(pageCollaborators[page.id]).toContainEqual(
      expect.objectContaining({
        userId: recipient.id,
        email: recipient.email,
        shareId: expect.any(String),
        permission: 'view',
        source: 'Email',
      }),
    );

    const folderCollaboratorsRes = await app.request(
      `/api/shares/folders/collaborators?folderIds=${folder.id}`,
      { headers: { Cookie: ownerSession.Cookie } },
    );
    expect(folderCollaboratorsRes.status).toBe(200);
    const folderCollaborators = (await folderCollaboratorsRes.json()) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(folderCollaborators[folder.id]?.[0]).toEqual(
      expect.objectContaining({
        userId: owner.id,
        email: owner.email,
        permission: 'edit',
        source: 'Owner',
      }),
    );
  });
});
