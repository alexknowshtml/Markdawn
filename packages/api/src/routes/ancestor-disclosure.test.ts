import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

type Permission = 'view' | 'edit' | 'admin';

async function addInvite(
  entityType: 'page' | 'folder',
  entityId: string,
  ownerId: string,
  recipientId: string,
  permission: Permission,
): Promise<void> {
  await query(
    `insert into shares (
       entity_type, entity_id, shared_by, recipient_user_id, permission
     ) values ($1, $2, $3, $4, $5)`,
    [entityType, entityId, ownerId, recipientId, permission],
  );
}

async function enableFolderLink(folderId: string, ownerId: string): Promise<string> {
  const token = crypto.randomUUID();
  await query('update folders set is_public = true, public_token = $1 where id = $2', [
    token,
    folderId,
  ]);
  await query(
    `insert into shares (entity_type, entity_id, shared_by, permission, token)
     values ('folder', $1, $2, 'view', $3)`,
    [folderId, ownerId, token],
  );
  return token;
}

function expectHiddenParent(
  value: Record<string, unknown>,
  parentId: string,
  parentName: string,
  parentToken: string,
): void {
  expect(value.parentId).toBeNull();
  expect(Object.hasOwn(value, 'parent_id')).toBe(false);
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain(parentId);
  expect(encoded).not.toContain(parentName);
  expect(encoded).not.toContain(parentToken);
}

function findFolderNode(nodes: unknown, folderId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(nodes)) return undefined;
  for (const value of nodes as unknown[]) {
    if (!value || typeof value !== 'object') continue;
    const node = value as Record<string, unknown>;
    if (node.id === folderId) return node;
    const child = findFolderNode(node.children, folderId);
    if (child) return child;
  }
  return undefined;
}

describe.each([
  'view',
  'edit',
  'admin',
] as const)('authenticated page ancestor privacy for a direct %s grant', (permission) => {
  it('keeps an unvisited public parent private until that folder is opened explicitly', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const inheritedViewer = await createTestUser();
    const recipientSession = await createTestSession(recipient.id);
    const hiddenParent = await createTestFolder(owner.id, { name: 'Hidden Public Parent' });
    const page = await createTestPage(owner.id, {
      parentId: hiddenParent.id,
      title: `Direct ${permission} page`,
    });
    const sibling = await createTestPage(owner.id, {
      parentId: hiddenParent.id,
      title: `Hidden sibling ${permission}`,
    });
    const parentToken = await enableFolderLink(hiddenParent.id, owner.id);
    await addInvite('page', page.id, owner.id, recipient.id, permission);
    await addInvite('folder', hiddenParent.id, owner.id, inheritedViewer.id, 'view');

    const detailRes = await app.request(`/api/pages/${page.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(detailRes.status).toBe(200);
    expectHiddenParent(
      (await detailRes.json()) as Record<string, unknown>,
      hiddenParent.id,
      hiddenParent.name,
      parentToken,
    );

    const accessRes = await app.request(`/api/pages/${page.id}/access`, {
      method: 'POST',
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(accessRes.status).toBe(200);
    expect(await accessRes.json()).toMatchObject({
      recordedLinkAccess: false,
      linkAccessSource: null,
    });
    const hiddenParentEvents = await query<{ count: string }>(
      `select count(*)::text as count
         from folder_access_events
         where folder_id = $1 and user_id = $2`,
      [hiddenParent.id, recipient.id],
    );
    expect(hiddenParentEvents.rows[0]?.count).toBe('0');

    const treeRes = await app.request('/api/pages/tree', {
      headers: { Cookie: recipientSession.Cookie },
    });
    const tree = (await treeRes.json()) as Array<Record<string, unknown>>;
    const pageNode = tree.find((node) => node.id === page.id);
    expect(pageNode).toBeDefined();
    expectHiddenParent(pageNode ?? {}, hiddenParent.id, hiddenParent.name, parentToken);
    expect(tree.some((node) => node.id === sibling.id)).toBe(false);

    if (permission !== 'view') {
      const updateRes = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: recipientSession.Cookie },
        body: JSON.stringify({ title: `Updated ${permission} page` }),
      });
      expect(updateRes.status).toBe(200);
      expectHiddenParent(
        (await updateRes.json()) as Record<string, unknown>,
        hiddenParent.id,
        hiddenParent.name,
        parentToken,
      );
    }

    if (permission === 'admin') {
      const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(summaryRes.status).toBe(200);
      const summary = (await summaryRes.json()) as {
        accessSources: Array<Record<string, unknown>>;
        inheritedLinks: unknown[];
      };
      expect(summary.inheritedLinks).toEqual([]);
      expect(summary.accessSources).toContainEqual(
        expect.objectContaining({
          kind: 'folder',
          userId: inheritedViewer.id,
          shareId: null,
        }),
      );
      const folderSource = summary.accessSources.find(
        (source) => source.kind === 'folder' && source.userId === inheritedViewer.id,
      );
      expect(folderSource).toBeDefined();
      expect(Object.hasOwn(folderSource ?? {}, 'folderId')).toBe(false);
      expect(Object.hasOwn(folderSource ?? {}, 'folderName')).toBe(false);
      expectHiddenParent(
        { parentId: null, summary },
        hiddenParent.id,
        hiddenParent.name,
        parentToken,
      );
    }

    const explicitFolderRes = await app.request(`/api/folders/${hiddenParent.id}`, {
      headers: { Cookie: recipientSession.Cookie, 'x-share-token': parentToken },
    });
    expect(explicitFolderRes.status).toBe(200);

    const detailAfterVisit = await app.request(`/api/pages/${page.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect((await detailAfterVisit.json()) as Record<string, unknown>).toMatchObject({
      parentId: hiddenParent.id,
    });
    const treeAfterVisit = await app.request('/api/pages/tree', {
      headers: { Cookie: recipientSession.Cookie },
    });
    const visiblePages = (await treeAfterVisit.json()) as Array<Record<string, unknown>>;
    expect(visiblePages).toContainEqual(expect.objectContaining({ id: sibling.id }));
  });
});

describe.each([
  'view',
  'edit',
  'admin',
] as const)('authenticated folder ancestor privacy for a direct %s grant', (permission) => {
  it('does not turn a child-folder request into hidden ancestor provenance', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const recipientSession = await createTestSession(recipient.id);
    const hiddenParent = await createTestFolder(owner.id, { name: 'Hidden Folder Parent' });
    const folder = await createTestFolder(owner.id, {
      name: `Direct ${permission} folder`,
      parentId: hiddenParent.id,
    });
    const sibling = await createTestFolder(owner.id, {
      name: `Hidden folder sibling ${permission}`,
      parentId: hiddenParent.id,
    });
    const parentToken = await enableFolderLink(hiddenParent.id, owner.id);
    await addInvite('folder', folder.id, owner.id, recipient.id, permission);

    const detailRes = await app.request(`/api/folders/${folder.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect(detailRes.status).toBe(200);
    expectHiddenParent(
      (await detailRes.json()) as Record<string, unknown>,
      hiddenParent.id,
      hiddenParent.name,
      parentToken,
    );
    const hiddenParentEvents = await query<{ count: string }>(
      `select count(*)::text as count
         from folder_access_events
         where folder_id = $1 and user_id = $2`,
      [hiddenParent.id, recipient.id],
    );
    expect(hiddenParentEvents.rows[0]?.count).toBe('0');

    const treeRes = await app.request('/api/folders/tree', {
      headers: { Cookie: recipientSession.Cookie },
    });
    const tree = await treeRes.json();
    const folderNode = findFolderNode(tree, folder.id);
    expect(folderNode).toBeDefined();
    expectHiddenParent(folderNode ?? {}, hiddenParent.id, hiddenParent.name, parentToken);
    expect(findFolderNode(tree, sibling.id)).toBeUndefined();

    if (permission === 'admin') {
      const updateRes = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: recipientSession.Cookie },
        body: JSON.stringify({ name: 'Updated direct admin folder' }),
      });
      expect(updateRes.status).toBe(200);
      expectHiddenParent(
        (await updateRes.json()) as Record<string, unknown>,
        hiddenParent.id,
        hiddenParent.name,
        parentToken,
      );

      const summaryRes = await app.request(`/api/shares/entity/folder/${folder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      const summary = (await summaryRes.json()) as { inheritedLinks: unknown[] };
      expect(summary.inheritedLinks).toEqual([]);
      expect(JSON.stringify(summary)).not.toContain(parentToken);
    }

    const explicitFolderRes = await app.request(`/api/folders/${hiddenParent.id}`, {
      headers: { Cookie: recipientSession.Cookie, 'x-share-token': parentToken },
    });
    expect(explicitFolderRes.status).toBe(200);
    const detailAfterVisit = await app.request(`/api/folders/${folder.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect((await detailAfterVisit.json()) as Record<string, unknown>).toMatchObject({
      parentId: hiddenParent.id,
    });
  });
});

describe('enumerable parent disclosure', () => {
  it('keeps immediate parent ids when a folder grant makes the path enumerable', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const recipientSession = await createTestSession(recipient.id);
    const parent = await createTestFolder(owner.id, { name: 'Enumerable Parent' });
    const child = await createTestFolder(owner.id, {
      name: 'Enumerable Child',
      parentId: parent.id,
    });
    const page = await createTestPage(owner.id, {
      title: 'Enumerable Page',
      parentId: child.id,
    });
    await addInvite('folder', parent.id, owner.id, recipient.id, 'view');

    const pageRes = await app.request(`/api/pages/${page.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect((await pageRes.json()) as Record<string, unknown>).toMatchObject({
      parentId: child.id,
    });
    const folderRes = await app.request(`/api/folders/${child.id}`, {
      headers: { Cookie: recipientSession.Cookie },
    });
    expect((await folderRes.json()) as Record<string, unknown>).toMatchObject({
      parentId: parent.id,
    });
  });
});
