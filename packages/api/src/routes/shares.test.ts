import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';

describe('shares API — comprehensive sharing infrastructure', () => {
  beforeAll(async () => {
    await query("SET session_replication_role = 'replica'");
  });

  afterAll(async () => {
    await query("SET session_replication_role = 'origin'");
  });

  const getShareIdForRecipient = async (recipientUserId: string): Promise<string> => {
    const result = await query<{ id: string }>(
      'SELECT id FROM shares WHERE recipient_user_id = $1 LIMIT 1',
      [recipientUserId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Expected share for recipient ${recipientUserId}`);
    }
    return row.id;
  };

  describe('closure table maintenance', () => {
    it('inserts folder closure rows on folder creation', async () => {
      const owner = await createTestUser();
      const parent = await createTestFolder(owner.id, { name: 'Parent' });
      const child = await createTestFolder(owner.id, { name: 'Child', parentId: parent.id });

      const closure = await query(
        'SELECT ancestor_id, descendant_id, depth FROM folder_closure WHERE descendant_id = $1 ORDER BY depth',
        [child.id],
      );

      expect(closure.rows).toHaveLength(2);
      expect(closure.rows[0]).toEqual({ ancestor_id: child.id, descendant_id: child.id, depth: 0 });
      expect(closure.rows[1]).toEqual({
        ancestor_id: parent.id,
        descendant_id: child.id,
        depth: 1,
      });
    });

    it('rebuilds closure on folder move', async () => {
      const owner = await createTestUser();
      const folderA = await createTestFolder(owner.id, { name: 'A' });
      const folderB = await createTestFolder(owner.id, { name: 'B' });
      const folderC = await createTestFolder(owner.id, { name: 'C', parentId: folderA.id });

      await query('UPDATE folders SET parent_id = $1 WHERE id = $2', [folderB.id, folderC.id]);

      const closure = await query(
        'SELECT ancestor_id, descendant_id, depth FROM folder_closure WHERE descendant_id = $1 ORDER BY depth',
        [folderC.id],
      );

      expect(closure.rows).toHaveLength(2);
      expect(closure.rows[0]).toEqual({
        ancestor_id: folderC.id,
        descendant_id: folderC.id,
        depth: 0,
      });
      expect(closure.rows[1]).toEqual({
        ancestor_id: folderB.id,
        descendant_id: folderC.id,
        depth: 1,
      });
    });

    it('cleans up closure on folder delete', async () => {
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id, { name: 'ToDelete' });

      await query('DELETE FROM folders WHERE id = $1', [folder.id]);

      const closure = await query(
        'SELECT 1 FROM folder_closure WHERE ancestor_id = $1 OR descendant_id = $1',
        [folder.id],
      );

      expect(closure.rows).toHaveLength(0);
    });

    it('prevents cycle creation via trigger', async () => {
      const owner = await createTestUser();
      const folderA = await createTestFolder(owner.id, { name: 'A' });
      const folderB = await createTestFolder(owner.id, { name: 'B', parentId: folderA.id });

      await expect(
        query('UPDATE folders SET parent_id = $1 WHERE id = $2', [folderB.id, folderA.id]),
      ).rejects.toThrow('Cannot move folder into its own subtree');
    });
  });

  describe('get_effective_page_permission SQL function', () => {
    it('returns edit permission for page owner (container-owned model, full_access)', async () => {
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        owner.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: true });
    });

    it('returns direct invite permission', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const page = await createTestPage(owner.id);

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['page', page.id, owner.id, recipient.id, 'view'],
      );

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'view', full_access: false });
    });

    it('returns inherited folder permission', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', folder.id, owner.id, recipient.id, 'edit'],
      );

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: false });
    });

    it('direct page invite overrides parent folder permission', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', folder.id, owner.id, recipient.id, 'admin'],
      );
      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['page', page.id, owner.id, recipient.id, 'view'],
      );

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'view', full_access: false });
    });

    it('direct folder invite takes priority over ancestor at same level', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const grandparent = await createTestFolder(owner.id, { name: 'GP' });
      const parent = await createTestFolder(owner.id, { name: 'P', parentId: grandparent.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', grandparent.id, owner.id, recipient.id, 'admin'],
      );
      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', parent.id, owner.id, recipient.id, 'view'],
      );

      const parentResult = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        parent.id,
        recipient.id,
      ]);
      expect(parentResult.rows[0]).toEqual({ permission: 'view', full_access: false });

      const gpResult = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        grandparent.id,
        recipient.id,
      ]);
      expect(gpResult.rows[0]).toEqual({ permission: 'admin', full_access: false });
    });

    it('returns null permission for no access', async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const page = await createTestPage(owner.id);

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        stranger.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });

    it('respects share expiration', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const page = await createTestPage(owner.id);

      await query(
        "INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour')",
        ['page', page.id, owner.id, recipient.id, 'edit'],
      );

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });

    it('grants workspace membership access', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const page = await createTestPage(owner.id);

      await createTestWorkspaceMember(owner.id, member.id);

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        member.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: false });
    });

    it('blocks workspace access in restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await createTestWorkspaceMember(owner.id, member.id);
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folder.id]);

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        member.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });
  });

  describe('get_page_base_permissions SQL function', () => {
    it('includes owner, direct invites, folder invites, and workspace members', async () => {
      const owner = await createTestUser();
      const directUser = await createTestUser();
      const folderUser = await createTestUser();
      const workspaceUser = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['page', page.id, owner.id, directUser.id, 'view'],
      );
      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', folder.id, owner.id, folderUser.id, 'edit'],
      );
      await createTestWorkspaceMember(owner.id, workspaceUser.id);

      const result = await query(
        'SELECT user_id, permission FROM get_page_base_permissions($1) ORDER BY user_id',
        [page.id],
      );

      const users = result.rows.map((r) => r.user_id);
      expect(users).toContain(owner.id);
      expect(users).toContain(directUser.id);
      expect(users).toContain(folderUser.id);
      expect(users).toContain(workspaceUser.id);
    });

    it('excludes folder invites when direct page invite exists', async () => {
      const owner = await createTestUser();
      const user = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', folder.id, owner.id, user.id, 'admin'],
      );
      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['page', page.id, owner.id, user.id, 'view'],
      );

      const result = await query('SELECT user_id, permission FROM get_page_base_permissions($1)', [
        page.id,
      ]);

      const userRow = result.rows.find((r) => r.user_id === user.id);
      expect(userRow).toBeDefined();
      if (!userRow) {
        throw new Error('Expected permission row for shared user');
      }
      expect(userRow.permission).toBe('view');
    });
  });

  describe('HTTP API — invites and access', () => {
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

    it('respects expiration date on invites', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id);

      const inviteRes = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({
          email: recipient.email,
          permission: 'edit',
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
        }),
      });
      expect(inviteRes.status).toBe(200);

      const pageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(pageRes.status).toBe(403);
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
  });

  describe('HTTP API — folder sharing and inheritance', () => {
    it('grants access to page inside shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, { title: 'Nested page', parentId: folder.id });

      const inviteRes = await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
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
      expect((await pageRes.json()).title).toBe('Nested page');
    });

    it('grants access to nested subfolder via ancestor share', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const grandparent = await createTestFolder(owner.id, { name: 'Grandparent' });
      const parent = await createTestFolder(owner.id, { name: 'Parent', parentId: grandparent.id });
      const child = await createTestFolder(owner.id, { name: 'Child', parentId: parent.id });

      const inviteRes = await app.request(`/api/shares/entity/folder/${grandparent.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      expect(inviteRes.status).toBe(200);

      const folderRes = await app.request(`/api/folders/${child.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(folderRes.status).toBe(200);
    });

    it('most permissive permission wins across sources', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { title: 'Override test', parentId: folder.id });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'admin' }),
      });
      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const summaryRes = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(summaryRes.status).toBe(200);
      const summary = (await summaryRes.json()) as {
        accessors: Array<{ permission: string; email: string | null }>;
      };
      const recipientAccessor = summary.accessors.find((a) => a.email === recipient.email);
      expect(recipientAccessor?.permission).toBe('admin');
    });
  });

  describe('HTTP API — workspace membership', () => {
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
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folder.id]);
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
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [
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

  describe('HTTP API — revoke and permission changes', () => {
    it('revokes individual access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id);

      const inviteRes = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      expect(inviteRes.status).toBe(200);

      const beforeRevoke = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(beforeRevoke.status).toBe(200);

      const shareId = await getShareIdForRecipient(recipient.id);

      const revokeRes = await app.request(`/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(revokeRes.status).toBe(200);

      const afterRevoke = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(afterRevoke.status).toBe(403);
    });

    it('updates permission level', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const shareId = await getShareIdForRecipient(recipient.id);

      const updateRes = await app.request(`/api/shares/${shareId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'admin' }),
      });
      expect(updateRes.status).toBe(200);

      const result = await query<{ permission: string }>(
        'SELECT permission FROM shares WHERE id = $1',
        [shareId],
      );
      expect(result.rows[0]?.permission).toBe('admin');
    });
  });

  describe('get_effective_folder_permission SQL function', () => {
    it('returns admin permission for folder owner (container-owned model, full_access)', async () => {
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id);

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        owner.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'admin', full_access: true });
    });

    it('returns direct invite permission for folder', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const folder = await createTestFolder(owner.id);

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', folder.id, owner.id, recipient.id, 'view'],
      );

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'view', full_access: false });
    });

    it('returns inherited ancestor folder permission', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const parent = await createTestFolder(owner.id, { name: 'Parent' });
      const child = await createTestFolder(owner.id, { name: 'Child', parentId: parent.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', parent.id, owner.id, recipient.id, 'edit'],
      );

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        child.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: false });
    });

    it('direct folder invite overrides ancestor folder access', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const grandparent = await createTestFolder(owner.id, { name: 'GP' });
      const parent = await createTestFolder(owner.id, { name: 'P', parentId: grandparent.id });

      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', grandparent.id, owner.id, recipient.id, 'admin'],
      );
      await query(
        'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
        ['folder', parent.id, owner.id, recipient.id, 'view'],
      );

      const parentResult = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        parent.id,
        recipient.id,
      ]);
      expect(parentResult.rows[0]).toEqual({ permission: 'view', full_access: false });

      const gpResult = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        grandparent.id,
        recipient.id,
      ]);
      expect(gpResult.rows[0]).toEqual({ permission: 'admin', full_access: false });
    });

    it('returns null permission for no folder access', async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const folder = await createTestFolder(owner.id);

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        stranger.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });

    it('respects share expiration on folders', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const folder = await createTestFolder(owner.id);

      await query(
        "INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour')",
        ['folder', folder.id, owner.id, recipient.id, 'edit'],
      );

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });

    it('grants workspace membership access to folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await createTestWorkspaceMember(owner.id, member.id);

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        member.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: false });
    });

    it('blocks workspace member access to restricted folder itself', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folder.id]);
      await createTestWorkspaceMember(owner.id, member.id);

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        folder.id,
        member.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });

    it('blocks workspace member access to descendant of restricted folder', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const restricted = await createTestFolder(owner.id, { name: 'Restricted' });
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [restricted.id]);
      const child = await createTestFolder(owner.id, { name: 'Child', parentId: restricted.id });
      await createTestWorkspaceMember(owner.id, member.id);

      const result = await query('SELECT * FROM get_effective_folder_permission($1, $2)', [
        child.id,
        member.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: null, full_access: false });
    });
  });

  describe('HTTP API — auth guard baselines', () => {
    it('returns 401 without session for with-me', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/shares/with-me');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid token for with-me', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: 'better-auth.session_token=invalid' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 without session for entity summary', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/shares/entity/page/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(401);
    });

    it('returns 401 without session for invite', async () => {
      const app = await createTestApp();
      const res = await app.request(
        '/api/shares/entity/page/00000000-0000-0000-0000-000000000000/invite',
        { method: 'POST' },
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 without session for link update', async () => {
      const app = await createTestApp();
      const res = await app.request(
        '/api/shares/entity/page/00000000-0000-0000-0000-000000000000/link',
        { method: 'PATCH' },
      );
      expect(res.status).toBe(401);
    });
  });

  describe('HTTP API — public / anonymous access', () => {
    it('allows anonymous access to a public page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Public doc' });

      await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'view' }),
      });

      const publicRes = await app.request(`/api/pages/${page.id}`);
      expect(publicRes.status).toBe(200);
      expect((await publicRes.json()).title).toBe('Public doc');
    });

    it('denies anonymous access after link is disabled', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'view' }),
      });

      await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'private' }),
      });

      const publicRes = await app.request(`/api/pages/${page.id}`);
      expect(publicRes.status).toBe(404);
    });
  });

  describe('HTTP API — error and edge cases', () => {
    it('rejects self-share invite', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ email: owner.email, permission: 'view' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invite to non-existent user', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ email: 'nobody@example.com', permission: 'view' }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects invite from non-admin user', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const rando = await createTestUser();
      const thirdUser = await createTestUser();
      const randoSession = await createTestSession(rando.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: randoSession.Cookie,
        },
        body: JSON.stringify({ email: thirdUser.email, permission: 'view' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects updating a non-existent share', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);

      const res = await app.request('/api/shares/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'admin' }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects revoking a non-existent share', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);

      const res = await app.request('/api/shares/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(404);
    });

    it('rejects invalid permission value', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'superadmin' }),
      });
      // parsePermission falls through to 'view', so invite succeeds with view
      expect(res.status).toBe(200);
    });

    it('allows recipient to self-remove their access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const shareId = await getShareIdForRecipient(recipient.id);

      const res = await app.request(`/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);

      const after = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(after.status).toBe(403);
    });
  });

  describe('HTTP API — permission behavior', () => {
    it('view permission user cannot update page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const viewerSession = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Original' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: viewer.email, permission: 'view' }),
      });

      const updateRes = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: viewerSession.Cookie,
        },
        body: JSON.stringify({ title: 'Hacked' }),
      });
      expect(updateRes.status).toBe(403);
    });

    it('edit permission user can read and update page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const editorSession = await createTestSession(editor.id);
      const page = await createTestPage(owner.id, { title: 'Original' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: editor.email, permission: 'edit' }),
      });

      const readRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: editorSession.Cookie },
      });
      expect(readRes.status).toBe(200);

      const updateRes = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: editorSession.Cookie,
        },
        body: JSON.stringify({ title: 'Updated' }),
      });
      expect(updateRes.status).toBe(200);
    });

    it('admin permission user can change share permissions', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: admin.email, permission: 'admin' }),
      });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: viewer.email, permission: 'view' }),
      });

      const shareId = await getShareIdForRecipient(viewer.id);

      const updateRes = await app.request(`/api/shares/${shareId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSession.Cookie,
        },
        body: JSON.stringify({ permission: 'edit' }),
      });
      expect(updateRes.status).toBe(200);
    });

    it('edit permission user cannot change share permissions', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const editorSession = await createTestSession(editor.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: editor.email, permission: 'edit' }),
      });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: viewer.email, permission: 'view' }),
      });

      const shareId = await getShareIdForRecipient(viewer.id);

      const updateRes = await app.request(`/api/shares/${shareId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: editorSession.Cookie,
        },
        body: JSON.stringify({ permission: 'edit' }),
      });
      expect(updateRes.status).toBe(403);
    });
  });

  describe('HTTP API — folder sharing', () => {
    it('allows invited user to access shared folder directly', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared' });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const res = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
    });

    it('allows access to nested subfolder via ancestor share', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const grandparent = await createTestFolder(owner.id, { name: 'GP' });
      const parent = await createTestFolder(owner.id, { name: 'P', parentId: grandparent.id });
      const child = await createTestFolder(owner.id, { name: 'C', parentId: parent.id });

      await app.request(`/api/shares/entity/folder/${grandparent.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const res = await app.request(`/api/folders/${child.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
    });

    it('folder tree includes shared folders for invited user', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const tree = (await res.json()) as Array<{ name: string }>;
      expect(tree).toContainEqual(expect.objectContaining({ name: 'Shared Folder' }));
    });

    it('marks restricted folders as lost access for workspace members in tree', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const memberSession = await createTestSession(member.id);
      const restrictedFolder = await createTestFolder(owner.id, { name: 'Secret' });
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [
        restrictedFolder.id,
      ]);
      await createTestWorkspaceMember(owner.id, member.id);

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: memberSession.Cookie },
      });
      expect(res.status).toBe(200);
      const tree = (await res.json()) as Array<{ name: string; isLostAccess: boolean }>;
      const found = tree.find((f) => f.name === 'Secret');
      expect(found).toBeDefined();
      expect(found?.isLostAccess).toBe(true);
    });
  });

  describe('HTTP API — share summary and with-me', () => {
    it('returns correct share summary for a page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Summary Test' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
      });

      const res = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        entity: { title: string; type: string };
        accessors: Array<{ name: string | null; permission: string; isOwner: boolean }>;
      };
      expect(data.entity.title).toBe('Summary Test');
      expect(data.accessors).toContainEqual(
        expect.objectContaining({
          name: owner.name,
          permission: 'edit',
          isOwner: true,
        }),
      );
      expect(data.accessors).toContainEqual(
        expect.objectContaining({
          name: recipient.name,
          permission: 'edit',
          isOwner: false,
        }),
      );
    });

    it('returns correct share summary for a folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id, { name: 'Folder Summary' });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const res = await app.request(`/api/shares/entity/folder/${folder.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        entity: { title: string };
        accessors: Array<{ name: string | null; permission: string; isOwner: boolean }>;
      };
      expect(data.entity.title).toBe('Folder Summary');
      expect(data.accessors).toContainEqual(
        expect.objectContaining({
          name: recipient.name,
          permission: 'view',
          isOwner: false,
        }),
      );
    });

    it('with-me returns invited pages and folders', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Shared Page' });
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
      });

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string; entityType: string }>;
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Page', entityType: 'page' }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Folder', entityType: 'folder' }),
      );
    });

    it('with-me excludes revoked shares', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Gone' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const shareId = await getShareIdForRecipient(recipient.id);

      await app.request(`/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string }>;
      expect(items).not.toContainEqual(expect.objectContaining({ title: 'Gone' }));
    });
  });

  describe('get_page_base_permissions SQL function', () => {
    it('includes link share users in base permissions', async () => {
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);
      const token = crypto.randomUUID();

      await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);
      await query(
        "INSERT INTO shares (entity_type, entity_id, permission, token) VALUES ('page', $1, 'view', $2)",
        [page.id, token],
      );

      const result = await query('SELECT user_id, permission FROM get_page_base_permissions($1)', [
        page.id,
      ]);

      // Link shares don't have a recipient_user_id, so they shouldn't appear
      // in get_page_base_permissions which only lists user-specific permissions.
      // Anonymous access is handled separately.
      const users = result.rows.map((r) => r.user_id);
      expect(users).toContain(owner.id);
      expect(users).toHaveLength(1);
    });

    it('excludes expired direct shares from base permissions', async () => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const page = await createTestPage(owner.id);

      await query(
        "INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at) VALUES ('page', $1, $2, $3, 'edit', NOW() - INTERVAL '1 day')",
        [page.id, owner.id, recipient.id],
      );

      const result = await query('SELECT user_id, permission FROM get_page_base_permissions($1)', [
        page.id,
      ]);

      const users = result.rows.map((r) => r.user_id);
      expect(users).not.toContain(recipient.id);
      expect(users).toContain(owner.id);
    });

    it('excludes workspace members in restricted folder from base permissions', async () => {
      const owner = await createTestUser();
      const member = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });
      await createTestWorkspaceMember(owner.id, member.id);
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [folder.id]);

      const result = await query('SELECT user_id, permission FROM get_page_base_permissions($1)', [
        page.id,
      ]);

      const users = result.rows.map((r) => r.user_id);
      expect(users).not.toContain(member.id);
      expect(users).toContain(owner.id);
    });
  });

  describe('HTTP API — ownership and security', () => {
    it('subfolder ownership resolves to root folder owner', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const subCreator = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const subCreatorSession = await createTestSession(subCreator.id);
      const rootFolder = await createTestFolder(owner.id, { name: 'Root' });
      const subFolder = await createTestFolder(subCreator.id, {
        name: 'Sub',
        parentId: rootFolder.id,
      });

      // Root folder owner owns everything inside — can access subfolder
      const res = await app.request(`/api/folders/${subFolder.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(res.status).toBe(200);

      // Subfolder creator does not own the container — root folder owner does.
      // Without an explicit share or workspace membership, access is denied.
      const subRes = await app.request(`/api/folders/${subFolder.id}`, {
        headers: { Cookie: subCreatorSession.Cookie },
      });
      expect(subRes.status).toBe(403);
    });

    it('editor cannot delete page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const editorSession = await createTestSession(editor.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: editor.email, permission: 'edit' }),
      });

      const deleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: editorSession.Cookie },
      });
      expect(deleteRes.status).toBe(403);
    });

    it('editor cannot delete folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const editorSession = await createTestSession(editor.id);
      const folder = await createTestFolder(owner.id);

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: editor.email, permission: 'edit' }),
      });

      const deleteRes = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: editorSession.Cookie },
      });
      expect(deleteRes.status).toBe(403);
    });

    it('soft-deleted page is not accessible publicly', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Public doc' });

      await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'view' }),
      });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      const publicRes = await app.request(`/api/pages/${page.id}`);
      expect(publicRes.status).toBe(404);
    });

    it('with-me returns invited pages and folders only', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Shared Page' });
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
      });

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string; entityType: string }>;
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Page', entityType: 'page' }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Folder', entityType: 'folder' }),
      );
    });
  });
});
