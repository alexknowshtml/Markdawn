import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import { createTestFolder, createTestPage, createTestUser } from '../test-utils';
import { ensureFolderAccess, ensurePageAccess } from './share-access';

async function addWorkspaceMember(
  workspaceOwnerId: string,
  memberId: string,
  role: string = 'editor',
) {
  await query(
    `INSERT INTO workspace_members (workspace_owner_id, member_id, role) VALUES ($1, $2, $3)`,
    [workspaceOwnerId, memberId, role],
  );
}

async function addShare(
  entityType: string,
  entityId: string,
  recipientUserId: string,
  permission: string,
  overrides?: { token?: string | null },
) {
  await query(
    `INSERT INTO shares (entity_type, entity_id, recipient_user_id, permission, token)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, recipientUserId, permission, overrides?.token ?? null],
  );
}

async function addLinkShare(pageId: string, permission: string) {
  const token = crypto.randomUUID();
  await query(
    `INSERT INTO shares (entity_type, entity_id, permission, token)
     VALUES ('page', $1, $2, $3)`,
    [pageId, permission, token],
  );
  await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
    token,
    pageId,
  ]);
}

async function addFolderLinkShare(folderId: string, permission: string) {
  const token = crypto.randomUUID();
  await query(
    `INSERT INTO shares (entity_type, entity_id, permission, token)
     VALUES ('folder', $1, $2, $3)`,
    [folderId, permission, token],
  );
  await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
    token,
    folderId,
  ]);
}

describe('ensurePageAccess with workspace membership', () => {
  it('grants edit access to workspace members', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const page = await createTestPage(owner.id);
    await addWorkspaceMember(owner.id, member.id);

    const result = await ensurePageAccess(page.id, member.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('edit');
  });

  it('grants admin access to workspace admin members', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser();
    const page = await createTestPage(owner.id);
    await addWorkspaceMember(owner.id, admin.id, 'admin');

    const result = await ensurePageAccess(page.id, admin.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('admin');
  });

  it('still grants owner access (regression)', async () => {
    const owner = await createTestUser();
    const page = await createTestPage(owner.id);

    const result = await ensurePageAccess(page.id, owner.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('edit');
  });

  it('still grants direct invite access (regression)', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const page = await createTestPage(owner.id);
    await addShare('page', page.id, recipient.id, 'view');

    const result = await ensurePageAccess(page.id, recipient.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('prefers higher permission from direct invite over workspace membership', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const page = await createTestPage(owner.id);
    await addWorkspaceMember(owner.id, member.id);
    // direct invite gives lower permission, workspace gives edit — highest wins
    await addShare('page', page.id, member.id, 'view');

    const result = await ensurePageAccess(page.id, member.id, 'edit');
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('edit');
  });

  it('still grants owner access when page has link share', async () => {
    const owner = await createTestUser();
    const page = await createTestPage(owner.id);
    await addLinkShare(page.id, 'edit');

    const result = await ensurePageAccess(page.id, owner.id);
    expect(result.hasAccess).toBe(true);
  });

  it('grants authenticated user access via public link', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const page = await createTestPage(owner.id);
    await addLinkShare(page.id, 'view');

    const result = await ensurePageAccess(page.id, stranger.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('grants inherited folder share access to nested page', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    await addShare('folder', folder.id, recipient.id, 'view');

    const result = await ensurePageAccess(page.id, recipient.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('blocks workspace membership when page inheritance is restricted', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const page = await createTestPage(owner.id);
    await addWorkspaceMember(owner.id, member.id);
    await query("UPDATE pages SET inheritance_policy = 'restricted' WHERE id = $1", [page.id]);

    await expect(ensurePageAccess(page.id, member.id)).rejects.toThrow(
      "You don't have access to this page",
    );
  });

  it('keeps direct page invites when page inheritance is restricted', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const page = await createTestPage(owner.id);
    await query("UPDATE pages SET inheritance_policy = 'restricted' WHERE id = $1", [page.id]);
    await addShare('page', page.id, recipient.id, 'view');

    const result = await ensurePageAccess(page.id, recipient.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('blocks parent folder share inheritance when page inheritance is restricted', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    await addShare('folder', folder.id, recipient.id, 'view');
    await query("UPDATE pages SET inheritance_policy = 'restricted' WHERE id = $1", [page.id]);

    await expect(ensurePageAccess(page.id, recipient.id)).rejects.toThrow(
      "You don't have access to this page",
    );
  });

  it('blocks inherited public folder links when page inheritance is restricted', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    await addFolderLinkShare(folder.id, 'view');
    await query("UPDATE pages SET inheritance_policy = 'restricted' WHERE id = $1", [page.id]);

    await expect(ensurePageAccess(page.id, stranger.id)).rejects.toThrow(
      "You don't have access to this page",
    );

    await addLinkShare(page.id, 'view');
    const result = await ensurePageAccess(page.id, stranger.id);
    expect(result.permission).toBe('view');
  });

  it('denies access to non-owner, non-member, non-shared users', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const page = await createTestPage(owner.id);

    await expect(ensurePageAccess(page.id, stranger.id)).rejects.toThrow(
      "You don't have access to this page",
    );
  });
});

describe('ensureFolderAccess with workspace membership', () => {
  it('grants access to workspace members', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const folder = await createTestFolder(owner.id);
    await addWorkspaceMember(owner.id, member.id);

    const result = await ensureFolderAccess(folder.id, member.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('edit');
  });

  it('grants owner access to folder', async () => {
    const owner = await createTestUser();
    const folder = await createTestFolder(owner.id);

    const result = await ensureFolderAccess(folder.id, owner.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('edit');
  });

  it('grants direct folder invite access', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    await addShare('folder', folder.id, recipient.id, 'view');

    const result = await ensureFolderAccess(folder.id, recipient.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('grants inherited ancestor folder share access', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const parentFolder = await createTestFolder(owner.id);
    const folder = await createTestFolder(owner.id, { parentId: parentFolder.id });
    await addShare('folder', parentFolder.id, recipient.id, 'view');

    const result = await ensureFolderAccess(folder.id, recipient.id);
    expect(result.hasAccess).toBe(true);
    expect(result.permission).toBe('view');
  });

  it('blocks ancestor folder shares when a nested folder is restricted', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const parentFolder = await createTestFolder(owner.id);
    const folder = await createTestFolder(owner.id, { parentId: parentFolder.id });
    await addShare('folder', parentFolder.id, recipient.id, 'view');
    await query("UPDATE folders SET inheritance_policy = 'restricted' WHERE id = $1", [folder.id]);

    await expect(ensureFolderAccess(folder.id, recipient.id)).rejects.toThrow(
      "You don't have access to this folder",
    );
  });

  it('lets direct shares on a restricted folder flow to descendants', async () => {
    const owner = await createTestUser();
    const recipient = await createTestUser();
    const folder = await createTestFolder(owner.id);
    const page = await createTestPage(owner.id, { parentId: folder.id });
    await query("UPDATE folders SET inheritance_policy = 'restricted' WHERE id = $1", [folder.id]);
    await addShare('folder', folder.id, recipient.id, 'edit');

    const folderResult = await ensureFolderAccess(folder.id, recipient.id);
    const pageResult = await ensurePageAccess(page.id, recipient.id);
    expect(folderResult.permission).toBe('edit');
    expect(pageResult.permission).toBe('edit');
  });

  it('denies access to non-owner, non-member, non-shared users', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const folder = await createTestFolder(owner.id);

    await expect(ensureFolderAccess(folder.id, stranger.id)).rejects.toThrow(
      "You don't have access to this folder",
    );
  });
});
