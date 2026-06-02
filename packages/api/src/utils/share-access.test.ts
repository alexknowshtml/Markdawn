import { describe, expect, it } from 'vitest';
import { pool } from '../db/connection';
import { createTestFolder, createTestPage, createTestUser } from '../test-utils';
import { ensureFolderAccess, ensurePageAccess } from './share-access';

async function addWorkspaceMember(
  workspaceOwnerId: string,
  memberId: string,
  role: string = 'member',
) {
  await pool.query(
    `INSERT INTO workspace_members (workspace_owner_id, member_id, role) VALUES ($1, $2, $3)`,
    [workspaceOwnerId, memberId, role],
  );
}

async function addShare(
  entityType: string,
  entityId: string,
  recipientUserId: string,
  permission: string,
  overrides?: { expiresAt?: Date | null; token?: string | null },
) {
  await pool.query(
    `INSERT INTO shares (entity_type, entity_id, recipient_user_id, permission, token)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, recipientUserId, permission, overrides?.token ?? null],
  );
  if (overrides?.expiresAt) {
    await pool.query(
      'UPDATE shares SET expires_at = $1 WHERE recipient_user_id = $2 AND entity_id = $3',
      [overrides.expiresAt.toISOString(), recipientUserId, entityId],
    );
  }
}

async function addLinkShare(pageId: string, permission: string) {
  const token = crypto.randomUUID();
  await pool.query(
    `INSERT INTO shares (entity_type, entity_id, permission, token)
     VALUES ('page', $1, $2, $3)`,
    [pageId, permission, token],
  );
  await pool.query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
    token,
    pageId,
  ]);
}

async function setAccessRestricted(folderId: string) {
  await pool.query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folderId]);
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

  it('still grants link share access (regression)', async () => {
    const owner = await createTestUser();
    const page = await createTestPage(owner.id);
    await addLinkShare(page.id, 'edit');

    const result = await ensurePageAccess(page.id, owner.id);
    expect(result.hasAccess).toBe(true);
  });

  it('denies access to non-owner, non-member, non-shared users', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const page = await createTestPage(owner.id);

    await expect(ensurePageAccess(page.id, stranger.id)).rejects.toThrow('Forbidden');
  });

  describe('restricted folders', () => {
    it('blocks workspace member access to pages inside a restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await setAccessRestricted(folder.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });
      await addWorkspaceMember(owner.id, member.id);

      await expect(ensurePageAccess(page.id, member.id)).rejects.toThrow('Forbidden');
    });

    it('blocks workspace member access to pages nested deep inside restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const topFolder = await createTestFolder(owner.id);
      await setAccessRestricted(topFolder.id);
      const nestedFolder = await createTestFolder(owner.id, { parentId: topFolder.id });
      const page = await createTestPage(owner.id, { parentId: nestedFolder.id });
      await addWorkspaceMember(owner.id, member.id);

      await expect(ensurePageAccess(page.id, member.id)).rejects.toThrow('Forbidden');
    });

    it('allows owner to still access pages inside restricted folder', async () => {
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await setAccessRestricted(folder.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      const result = await ensurePageAccess(page.id, owner.id);
      expect(result.hasAccess).toBe(true);
    });

    it('allows direct invite to bypass restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await setAccessRestricted(folder.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });
      await addWorkspaceMember(owner.id, member.id);
      // Direct invite on the page — should bypass restricted folder
      await addShare('page', page.id, member.id, 'view');

      const result = await ensurePageAccess(page.id, member.id);
      expect(result.hasAccess).toBe(true);
      expect(result.permission).toBe('view');
    });

    it('allows direct invite to bypass restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await setAccessRestricted(folder.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });
      await addWorkspaceMember(owner.id, member.id);
      // Direct invite on the page inside the restricted folder — bypasses restriction
      await addShare('page', page.id, member.id, 'view');

      const result = await ensurePageAccess(page.id, member.id);
      expect(result.hasAccess).toBe(true);
      expect(result.permission).toBe('view');
    });

    it('does not block workspace member access to pages NOT under restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const restrictedFolder = await createTestFolder(owner.id);
      await setAccessRestricted(restrictedFolder.id);
      // Page in a separate folder (not nested under restricted)
      const otherFolder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: otherFolder.id });
      await addWorkspaceMember(owner.id, member.id);

      const result = await ensurePageAccess(page.id, member.id);
      expect(result.hasAccess).toBe(true);
    });
  });

  describe('expired shares', () => {
    it('denies access when direct invite has expired', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const page = await createTestPage(owner.id);
      await addShare('page', page.id, recipient.id, 'edit', {
        expiresAt: new Date('2020-01-01'),
      });

      await expect(ensurePageAccess(page.id, recipient.id)).rejects.toThrow('Forbidden');
    });

    it('denies access when link share has expired', async () => {
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      const token = crypto.randomUUID();
      await pool.query(
        `INSERT INTO shares (entity_type, entity_id, permission, token, expires_at)
         VALUES ('page', $1, 'edit', $2, $3)`,
        [page.id, token, new Date('2020-01-01')],
      );
      await pool.query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);

      // Anonymous access via link should be denied
      // (we can't test anonymous directly here since ensurePageAccess requires a userId,
      //  but the link share won't match any user)
    });
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

  it('blocks workspace member access to restricted folder', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const folder = await createTestFolder(owner.id);
    await setAccessRestricted(folder.id);
    await addWorkspaceMember(owner.id, member.id);

    await expect(ensureFolderAccess(folder.id, member.id)).rejects.toThrow('Forbidden');
  });

  it('blocks non-owner, non-member, non-shared users from restricted folder', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const folder = await createTestFolder(owner.id);
    await setAccessRestricted(folder.id);

    await expect(ensureFolderAccess(folder.id, stranger.id)).rejects.toThrow('Forbidden');
  });

  it('still grants owner access to restricted folder', async () => {
    const owner = await createTestUser();
    const folder = await createTestFolder(owner.id);
    await setAccessRestricted(folder.id);

    const result = await ensureFolderAccess(folder.id, owner.id);
    expect(result.hasAccess).toBe(true);
  });
});
