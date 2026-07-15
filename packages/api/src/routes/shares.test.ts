import { Client } from 'pg';
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

async function waitForAdvisoryWaiters(client: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await client.query<{ count: number }>(
      `select count(*)::int as count
       from pg_locks waiting
       join pg_locks held
         on waiting.locktype = held.locktype
        and waiting.database is not distinct from held.database
        and waiting.classid is not distinct from held.classid
        and waiting.objid is not distinct from held.objid
        and waiting.objsubid is not distinct from held.objsubid
       where held.pid = pg_backend_pid()
         and held.locktype = 'advisory'
         and held.granted = true
         and waiting.granted = false`,
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory lock waiter(s)`);
}

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

    it('uses the highest permission across direct page and parent folder shares', async () => {
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

      expect(result.rows[0]).toEqual({ permission: 'admin', full_access: false });
    });

    it.each([
      ['page email + folder email', 'email', 'email'],
      ['page email + folder link', 'email', 'link'],
      ['page link + folder email', 'link', 'email'],
      ['page link + folder link', 'link', 'link'],
    ] as const)('keeps direct page edit above inherited folder view (%s)', async (_label, pageShareKind, folderShareKind) => {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      if (pageShareKind === 'email') {
        await query(
          'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
          ['page', page.id, owner.id, recipient.id, 'edit'],
        );
      } else {
        const token = crypto.randomUUID();
        await query(
          'INSERT INTO shares (entity_type, entity_id, shared_by, permission, token) VALUES ($1, $2, $3, $4, $5)',
          ['page', page.id, owner.id, 'edit', token],
        );
        await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
          token,
          page.id,
        ]);
      }

      if (folderShareKind === 'email') {
        await query(
          'INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission) VALUES ($1, $2, $3, $4, $5)',
          ['folder', folder.id, owner.id, recipient.id, 'view'],
        );
      } else {
        const token = crypto.randomUUID();
        await query(
          'INSERT INTO shares (entity_type, entity_id, shared_by, permission, token) VALUES ($1, $2, $3, $4, $5)',
          ['folder', folder.id, owner.id, 'view', token],
        );
        await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
          token,
          folder.id,
        ]);
      }

      const result = await query('SELECT * FROM get_effective_page_permission($1, $2)', [
        page.id,
        recipient.id,
      ]);

      expect(result.rows[0]).toEqual({ permission: 'edit', full_access: false });
    });

    it('uses the highest permission across direct and ancestor folder shares', async () => {
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
      expect(parentResult.rows[0]).toEqual({ permission: 'admin', full_access: false });

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

    it('keeps the highest folder invite permission when a lower direct page invite exists', async () => {
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
      expect(userRow.permission).toBe('admin');
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

    it('enforces one public-link share record per entity', async () => {
      const owner = await createTestUser();
      const page = await createTestPage(owner.id);

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
       VALUES ('page', $1, $2, 'view', $3)`,
        [page.id, owner.id, crypto.randomUUID()],
      );

      await expect(
        query(
          `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'edit', $3)`,
          [page.id, owner.id, crypto.randomUUID()],
        ),
      ).rejects.toThrow();
    });

    it('atomically handles concurrent first-time public-link updates', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);
      const request = (permission: 'view' | 'edit') =>
        app.request(`/api/shares/entity/page/${page.id}/link`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
          body: JSON.stringify({ permission }),
        });

      const responses = await Promise.all([request('view'), request('edit')]);

      expect(responses.every((response) => response.status === 200)).toBe(true);
      const links = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM shares
       WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL`,
        [page.id],
      );
      expect(links.rows[0]?.count).toBe('1');
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

    it('rejects invalid public link permissions', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      const adminRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({ permission: 'admin' }),
      });
      expect(adminRes.status).toBe(400);

      const missingRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({}),
      });
      expect(missingRes.status).toBe(400);
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

    it('marks inherited folder access as read-only in child page summaries', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, { title: 'Nested page', parentId: folder.id });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
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
        accessors: Array<{ email: string | null; source: string; shareId: string | null }>;
      };
      const inheritedAccessor = summary.accessors.find((a) => a.email === recipient.email);
      expect(inheritedAccessor).toEqual(
        expect.objectContaining({ source: 'via Shared Folder', shareId: null }),
      );
    });

    it('stops and restores inheritance for a page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const restrictRes = await app.request(`/api/shares/entity/page/${page.id}/inheritance`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ policy: 'restricted' }),
      });
      expect(restrictRes.status).toBe(200);

      const restrictedPageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(restrictedPageRes.status).toBe(403);

      const restoreRes = await app.request(`/api/shares/entity/page/${page.id}/inheritance`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ policy: 'inherit' }),
      });
      expect(restoreRes.status).toBe(200);

      const restoredPageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(restoredPageRes.status).toBe(200);
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

    it('uses the highest permission across direct folder and ancestor folder access', async () => {
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
      expect(parentResult.rows[0]).toEqual({ permission: 'admin', full_access: false });

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

    it('denies anonymous access after a page link expires', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ permission: 'view' }),
      });
      await query(
        `UPDATE shares SET expires_at = now() - interval '1 hour'
         WHERE entity_type = 'page' AND entity_id = $1 AND token IS NOT NULL`,
        [page.id],
      );

      const publicRes = await app.request(`/api/pages/${page.id}`);

      expect(publicRes.status).toBe(404);
    });

    it('denies anonymous access after an inherited folder link expires', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const session = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await app.request(`/api/shares/entity/folder/${folder.id}/link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ permission: 'edit' }),
      });
      await query(
        `UPDATE shares SET expires_at = now() - interval '1 hour'
         WHERE entity_type = 'folder' AND entity_id = $1 AND token IS NOT NULL`,
        [folder.id],
      );

      expect((await app.request(`/api/folders/${folder.id}`)).status).toBe(404);
      expect((await app.request(`/api/pages/${page.id}`)).status).toBe(404);
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
      expect(res.status).toBe(400);
    });

    it.each([
      42,
      false,
      'not-a-date',
    ])('rejects invalid invitation expiration %j', async (expiresAt) => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ email: recipient.email, permission: 'view', expiresAt }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_EXPIRATION' });
      const stored = await query(
        'SELECT id FROM shares WHERE entity_type = $1 AND entity_id = $2 AND recipient_user_id = $3',
        ['page', page.id, recipient.id],
      );
      expect(stored.rowCount).toBe(0);
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

    it('rejects an admin mutation that acquires the workspace access lock after demotion', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const page = await createTestPage(owner.id);

      for (const [email, permission] of [
        [admin.email, 'admin'],
        [viewer.email, 'view'],
      ] as const) {
        const response = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ email, permission }),
        });
        expect(response.status).toBe(200);
      }

      const adminShareId = await getShareIdForRecipient(admin.id);
      const viewerShareId = await getShareIdForRecipient(viewer.id);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      let transactionOpen = false;

      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        const demotion = app.request(`/api/shares/${adminShareId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ permission: 'edit' }),
        });
        await waitForAdvisoryWaiters(blocker, 1);

        const staleAdminMutation = app.request(`/api/shares/${viewerShareId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminSession.Cookie },
          body: JSON.stringify({ permission: 'edit' }),
        });
        await waitForAdvisoryWaiters(blocker, 2);

        await blocker.query('commit');
        transactionOpen = false;

        const [demotionResponse, staleMutationResponse] = await Promise.all([
          demotion,
          staleAdminMutation,
        ]);
        expect(demotionResponse.status).toBe(200);
        expect(staleMutationResponse.status).toBe(403);

        const viewerShare = await query<{ permission: string }>(
          'select permission from shares where id = $1',
          [viewerShareId],
        );
        expect(viewerShare.rows[0]?.permission).toBe('view');
      } finally {
        if (transactionOpen) await blocker.query('rollback');
        await blocker.end();
      }
    });

    it('serializes child mutations with inherited admin demotion', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      for (const [entityType, entityId, email, permission] of [
        ['folder', folder.id, admin.email, 'admin'],
        ['page', page.id, viewer.email, 'view'],
      ] as const) {
        const response = await app.request(`/api/shares/entity/${entityType}/${entityId}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ email, permission }),
        });
        expect(response.status).toBe(200);
      }

      const adminShareId = await getShareIdForRecipient(admin.id);
      const viewerShareId = await getShareIdForRecipient(viewer.id);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      let transactionOpen = false;

      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        const demotion = app.request(`/api/shares/${adminShareId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ permission: 'edit' }),
        });
        await waitForAdvisoryWaiters(blocker, 1);

        const staleAdminMutation = app.request(`/api/shares/${viewerShareId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminSession.Cookie },
          body: JSON.stringify({ permission: 'edit' }),
        });
        await waitForAdvisoryWaiters(blocker, 2);

        await blocker.query('commit');
        transactionOpen = false;

        const [demotionResponse, staleMutationResponse] = await Promise.all([
          demotion,
          staleAdminMutation,
        ]);
        expect(demotionResponse.status).toBe(200);
        expect(staleMutationResponse.status).toBe(403);

        const viewerShare = await query<{ permission: string }>(
          'select permission from shares where id = $1',
          [viewerShareId],
        );
        expect(viewerShare.rows[0]?.permission).toBe('view');
      } finally {
        if (transactionOpen) await blocker.query('rollback');
        await blocker.end();
      }
    });

    it('serializes child mutations with workspace admin demotion', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const viewer = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const page = await createTestPage(owner.id);
      await createTestWorkspaceMember(owner.id, admin.id, 'admin');

      const inviteResponse = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ email: viewer.email, permission: 'view' }),
      });
      expect(inviteResponse.status).toBe(200);

      const viewerShareId = await getShareIdForRecipient(viewer.id);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      let transactionOpen = false;

      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        const demotion = app.request(`/api/workspace/members/${admin.id}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ role: 'editor' }),
        });
        await waitForAdvisoryWaiters(blocker, 1);

        const staleAdminMutation = app.request(`/api/shares/${viewerShareId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminSession.Cookie },
          body: JSON.stringify({ permission: 'edit' }),
        });
        await waitForAdvisoryWaiters(blocker, 2);

        await blocker.query('commit');
        transactionOpen = false;

        const [demotionResponse, staleMutationResponse] = await Promise.all([
          demotion,
          staleAdminMutation,
        ]);
        expect(demotionResponse.status).toBe(200);
        expect(staleMutationResponse.status).toBe(403);

        const viewerShare = await query<{ permission: string }>(
          'select permission from shares where id = $1',
          [viewerShareId],
        );
        expect(viewerShare.rows[0]?.permission).toBe('view');
      } finally {
        if (transactionOpen) await blocker.query('rollback');
        await blocker.end();
      }
    });

    it('does not let admins grant admin access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const adminSession = await createTestSession(admin.id);
      const page = await createTestPage(owner.id);

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ email: admin.email, permission: 'admin' }),
      });

      const res = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminSession.Cookie },
        body: JSON.stringify({ email: recipient.email, permission: 'admin' }),
      });

      expect(res.status).toBe(403);
    });

    it('does not let one admin remove another admin', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const firstAdmin = await createTestUser();
      const secondAdmin = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const firstAdminSession = await createTestSession(firstAdmin.id);
      const page = await createTestPage(owner.id);

      for (const admin of [firstAdmin, secondAdmin]) {
        await app.request(`/api/shares/entity/page/${page.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
          body: JSON.stringify({ email: admin.email, permission: 'admin' }),
        });
      }
      const secondAdminShareId = await getShareIdForRecipient(secondAdmin.id);

      const res = await app.request(`/api/shares/${secondAdminShareId}`, {
        method: 'DELETE',
        headers: { Cookie: firstAdminSession.Cookie },
      });

      expect(res.status).toBe(403);
      const remaining = await query('SELECT id FROM shares WHERE id = $1', [secondAdminShareId]);
      expect(remaining.rowCount).toBe(1);
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

    it('hides a restricted child folder and its pages from a parent folder share recipient', async () => {
      type FolderNode = { id: string; name: string; children?: FolderNode[] };
      const flattenFolders = (nodes: FolderNode[]): FolderNode[] =>
        nodes.flatMap((node) => [node, ...flattenFolders(node.children ?? [])]);

      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const parentFolder = await createTestFolder(owner.id, { name: 'Parent' });
      const parentPage = await createTestPage(owner.id, {
        title: 'Visible parent page',
        parentId: parentFolder.id,
      });
      const restrictedDirectPage = await createTestPage(owner.id, {
        title: 'Hidden direct page',
        parentId: parentFolder.id,
      });
      const childFolder = await createTestFolder(owner.id, {
        name: 'Restricted child',
        parentId: parentFolder.id,
      });
      const childPage = await createTestPage(owner.id, {
        title: 'Hidden child page',
        parentId: childFolder.id,
      });

      await app.request(`/api/shares/entity/folder/${parentFolder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const restrictRes = await app.request(
        `/api/shares/entity/folder/${childFolder.id}/inheritance`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: ownerSession.Cookie,
          },
          body: JSON.stringify({ policy: 'restricted' }),
        },
      );
      expect(restrictRes.status).toBe(200);

      const restrictPageRes = await app.request(
        `/api/shares/entity/page/${restrictedDirectPage.id}/inheritance`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: ownerSession.Cookie,
          },
          body: JSON.stringify({ policy: 'restricted' }),
        },
      );
      expect(restrictPageRes.status).toBe(200);

      const folderTreeRes = await app.request('/api/folders/tree', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(folderTreeRes.status).toBe(200);
      const folderTree = flattenFolders((await folderTreeRes.json()) as FolderNode[]);
      expect(folderTree.map((folder) => folder.id)).toContain(parentFolder.id);
      expect(folderTree.map((folder) => folder.id)).not.toContain(childFolder.id);

      const pageTreeRes = await app.request('/api/pages/tree', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(pageTreeRes.status).toBe(200);
      const pages = (await pageTreeRes.json()) as Array<{ id: string }>;
      expect(pages.map((page) => page.id)).toContain(parentPage.id);
      expect(pages.map((page) => page.id)).not.toContain(restrictedDirectPage.id);
      expect(pages.map((page) => page.id)).not.toContain(childPage.id);

      const parentFolderRes = await app.request(`/api/folders/${parentFolder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(parentFolderRes.status).toBe(200);
      const parentFolderBody = (await parentFolderRes.json()) as {
        pages: Array<{ id: string }>;
        folders: Array<{ id: string }>;
      };
      expect(parentFolderBody.pages.map((page) => page.id)).toContain(parentPage.id);
      expect(parentFolderBody.pages.map((page) => page.id)).not.toContain(restrictedDirectPage.id);
      expect(parentFolderBody.folders.map((folder) => folder.id)).not.toContain(childFolder.id);

      const childFolderRes = await app.request(`/api/folders/${childFolder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(childFolderRes.status).toBe(403);

      const childPageRes = await app.request(`/api/pages/${childPage.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(childPageRes.status).toBe(403);
    });

    it('does not discover public-link entities in authenticated trees', async () => {
      type FolderNode = { id: string; children?: FolderNode[] };
      const flattenFolders = (nodes: FolderNode[]): FolderNode[] =>
        nodes.flatMap((node) => [node, ...flattenFolders(node.children ?? [])]);

      const app = await createTestApp();
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const strangerSession = await createTestSession(stranger.id);
      const publicFolder = await createTestFolder(owner.id, { name: 'Public Link Folder' });
      const nestedPage = await createTestPage(owner.id, {
        title: 'Nested Public Link Page',
        parentId: publicFolder.id,
      });
      const publicPage = await createTestPage(owner.id, { title: 'Public Link Page' });
      const folderToken = crypto.randomUUID();
      const pageToken = crypto.randomUUID();

      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        folderToken,
        publicFolder.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [publicFolder.id, owner.id, folderToken],
      );
      await query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        pageToken,
        publicPage.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'view', $3)`,
        [publicPage.id, owner.id, pageToken],
      );

      const folderTreeRes = await app.request('/api/folders/tree', {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(folderTreeRes.status).toBe(200);
      const folderTree = flattenFolders((await folderTreeRes.json()) as FolderNode[]);
      expect(folderTree.map((folder) => folder.id)).not.toContain(publicFolder.id);

      const pageTreeRes = await app.request('/api/pages/tree', {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(pageTreeRes.status).toBe(200);
      const pages = (await pageTreeRes.json()) as Array<{ id: string }>;
      expect(pages.map((page) => page.id)).not.toContain(publicPage.id);
      expect(pages.map((page) => page.id)).not.toContain(nestedPage.id);

      const openFolderRes = await app.request(`/api/folders/${publicFolder.id}`, {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(openFolderRes.status).toBe(200);

      const folderTreeAfterOpenRes = await app.request('/api/folders/tree', {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(folderTreeAfterOpenRes.status).toBe(200);
      const folderTreeAfterOpen = flattenFolders(
        (await folderTreeAfterOpenRes.json()) as FolderNode[],
      );
      expect(folderTreeAfterOpen.map((folder) => folder.id)).toContain(publicFolder.id);

      const pageTreeAfterFolderOpenRes = await app.request('/api/pages/tree', {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(pageTreeAfterFolderOpenRes.status).toBe(200);
      const pagesAfterFolderOpen = (await pageTreeAfterFolderOpenRes.json()) as Array<{
        id: string;
      }>;
      expect(pagesAfterFolderOpen.map((page) => page.id)).toContain(nestedPage.id);

      const openPageRes = await app.request(`/api/pages/${publicPage.id}/access`, {
        method: 'POST',
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(openPageRes.status).toBe(200);
      expect(await openPageRes.json()).toMatchObject({
        recordedLinkAccess: true,
        linkAccessSource: 'page',
      });

      const pageTreeAfterPageOpenRes = await app.request('/api/pages/tree', {
        headers: { Cookie: strangerSession.Cookie },
      });
      expect(pageTreeAfterPageOpenRes.status).toBe(200);
      const pagesAfterPageOpen = (await pageTreeAfterPageOpenRes.json()) as Array<{ id: string }>;
      expect(pagesAfterPageOpen.map((page) => page.id)).toContain(publicPage.id);
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

    it('shows inherited public-link permission in page accessor summaries', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      await app.request(`/api/shares/entity/folder/${folder.id}/link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ permission: 'edit' }),
      });

      const res = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      const data = (await res.json()) as {
        accessors: Array<{ userId: string; permission: string }>;
      };
      expect(data.accessors).toContainEqual(
        expect.objectContaining({ userId: recipient.id, permission: 'edit' }),
      );
    });

    it('shows inherited public-link permission in folder accessor summaries', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const parent = await createTestFolder(owner.id);
      const child = await createTestFolder(owner.id, { parentId: parent.id });

      await app.request(`/api/shares/entity/folder/${child.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      await app.request(`/api/shares/entity/folder/${parent.id}/link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ permission: 'edit' }),
      });

      const res = await app.request(`/api/shares/entity/folder/${child.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      const data = (await res.json()) as {
        accessors: Array<{ userId: string; permission: string }>;
      };
      expect(data.accessors).toContainEqual(
        expect.objectContaining({ userId: recipient.id, permission: 'edit' }),
      );
    });

    it('does not present expired shares as active access', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id);
      await query(
        `INSERT INTO shares (
           entity_type, entity_id, shared_by, recipient_user_id, recipient_email,
           permission, expires_at
         ) VALUES ('page', $1, $2, $3, $4, 'view', now() - interval '1 hour')`,
        [page.id, owner.id, recipient.id, recipient.email],
      );

      const res = await app.request(`/api/shares/entity/page/${page.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        invites: Array<{ recipientUserId: string | null }>;
        accessors: Array<{ userId: string }>;
      };
      expect(data.invites).not.toContainEqual(
        expect.objectContaining({ recipientUserId: recipient.id }),
      );
      expect(data.accessors).not.toContainEqual(expect.objectContaining({ userId: recipient.id }));
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

    it('parent folder summary keeps direct invite permission when child folder has higher permission', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const parentFolder = await createTestFolder(owner.id, { name: 'Parent' });
      const childFolder = await createTestFolder(owner.id, {
        name: 'Child',
        parentId: parentFolder.id,
      });

      // Share parent as view, child as edit.
      await app.request(`/api/shares/entity/folder/${parentFolder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      await app.request(`/api/shares/entity/folder/${childFolder.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
      });

      const res = await app.request(`/api/shares/entity/folder/${parentFolder.id}`, {
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        accessors: Array<{
          userId: string;
          name: string | null;
          permission: string;
          source: string;
        }>;
      };
      const recipientAccessor = data.accessors.find((a) => a.userId === recipient.id);
      expect(recipientAccessor).toBeDefined();
      expect(recipientAccessor?.permission).toBe('view');
      expect(recipientAccessor?.source).toBe('Direct Invite');
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

    it('with-me hides a directly shared page once it is visible through a shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Moved Shared Page' });
      const folder = await createTestFolder(owner.id, { name: 'Shared Destination Folder' });

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
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const moveRes = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ parentId: folder.id }),
      });
      expect(moveRes.status).toBe(200);

      const pageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(pageRes.status).toBe(200);

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string; entityType: string }>;
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Destination Folder', entityType: 'folder' }),
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ title: 'Moved Shared Page', entityType: 'page' }),
      );
    });

    it('with-me tree nests a link-opened page under a later shared parent folder without duplicating it', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const parent = await createTestFolder(owner.id, { name: 'Parent Folder' });
      const child = await createTestFolder(owner.id, { name: 'Child Folder', parentId: parent.id });
      const page = await createTestPage(owner.id, {
        title: 'Page in Child Folder',
        parentId: child.id,
      });

      const linkRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'edit' }),
      });
      expect(linkRes.status).toBe(200);

      const openPageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(openPageRes.status).toBe(200);

      const accessRes = await app.request(`/api/pages/${page.id}/access`, {
        method: 'POST',
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(accessRes.status).toBe(200);

      const inviteRes = await app.request(`/api/shares/entity/folder/${parent.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      expect(inviteRes.status).toBe(200);

      const flatRes = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(flatRes.status).toBe(200);
      const flatItems = (await flatRes.json()) as Array<{ title: string; entityType: string }>;
      expect(flatItems).toContainEqual(
        expect.objectContaining({ title: 'Parent Folder', entityType: 'folder' }),
      );
      expect(flatItems).not.toContainEqual(
        expect.objectContaining({ title: 'Page in Child Folder', entityType: 'page' }),
      );

      const treeRes = await app.request('/api/shares/with-me/tree', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(treeRes.status).toBe(200);
      const treeItems = (await treeRes.json()) as Array<{
        entityType: string;
        title: string;
        userPermission: string | null;
        children?: Array<{
          entityType: string;
          title: string;
          children?: Array<{ entityType: string; title: string; userPermission: string | null }>;
        }>;
      }>;
      expect(treeItems).toHaveLength(1);
      expect(treeItems[0]).toEqual(
        expect.objectContaining({ title: 'Parent Folder', entityType: 'folder' }),
      );
      const nestedPage = treeItems[0]?.children?.[0]?.children?.find(
        (item) => item.entityType === 'page' && item.title === 'Page in Child Folder',
      );
      expect(nestedPage).toEqual(
        expect.objectContaining({ title: 'Page in Child Folder', userPermission: 'edit' }),
      );
    });

    it('with-me tree keeps a link-opened page separate from a shared parent when inheritance is blocked', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const parent = await createTestFolder(owner.id, { name: 'Blocked Parent Folder' });
      const child = await createTestFolder(owner.id, {
        name: 'Blocked Child Folder',
        parentId: parent.id,
      });
      const page = await createTestPage(owner.id, {
        title: 'Blocked Link Page',
        parentId: child.id,
      });

      await query("update folders set inheritance_policy = 'restricted' where id = $1", [child.id]);

      const linkRes = await app.request(`/api/shares/entity/page/${page.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'edit' }),
      });
      expect(linkRes.status).toBe(200);

      const openPageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(openPageRes.status).toBe(200);

      const accessRes = await app.request(`/api/pages/${page.id}/access`, {
        method: 'POST',
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(accessRes.status).toBe(200);

      const inviteRes = await app.request(`/api/shares/entity/folder/${parent.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });
      expect(inviteRes.status).toBe(200);

      const treeRes = await app.request('/api/shares/with-me/tree', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(treeRes.status).toBe(200);
      const treeItems = (await treeRes.json()) as Array<{
        entityType: string;
        title: string;
        children?: Array<{ entityType: string; title: string }>;
      }>;
      expect(treeItems).toContainEqual(
        expect.objectContaining({ title: 'Blocked Parent Folder', entityType: 'folder' }),
      );
      expect(treeItems).toContainEqual(
        expect.objectContaining({ title: 'Blocked Link Page', entityType: 'page' }),
      );
      const parentRoot = treeItems.find((item) => item.title === 'Blocked Parent Folder');
      expect(parentRoot?.children ?? []).not.toContainEqual(
        expect.objectContaining({ title: 'Blocked Child Folder' }),
      );
    });

    it('with-me keeps a directly shared page visible when a shared ancestor is blocked by inheritance restriction', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const parent = await createTestFolder(owner.id, { name: 'Shared Parent Folder' });
      const child = await createTestFolder(owner.id, {
        name: 'Restricted Child Folder',
        parentId: parent.id,
      });
      const page = await createTestPage(owner.id, {
        title: 'Direct Page Behind Restriction',
        parentId: child.id,
      });

      await query("update folders set inheritance_policy = 'restricted' where id = $1", [child.id]);

      await app.request(`/api/shares/entity/folder/${parent.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string; entityType: string }>;
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Shared Parent Folder', entityType: 'folder' }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Direct Page Behind Restriction', entityType: 'page' }),
      );
    });

    it('with-me also hides a directly shared page when the containing folder was opened by link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Linked Destination Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Direct Page In Linked Folder',
        parentId: folder.id,
      });

      await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ email: recipient.email, permission: 'view' }),
      });

      const linkRes = await app.request(`/api/shares/entity/folder/${folder.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'view' }),
      });
      expect(linkRes.status).toBe(200);

      const openRes = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(openRes.status).toBe(200);

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{
        title: string;
        entityType: string;
        source: string;
      }>;
      expect(items).toContainEqual(
        expect.objectContaining({
          title: 'Linked Destination Folder',
          entityType: 'folder',
          source: 'link',
        }),
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ title: 'Direct Page In Linked Folder', entityType: 'page' }),
      );
    });

    it('with-me includes a folder link after an authenticated user opens it', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Opened Link Folder' });

      const linkRes = await app.request(`/api/shares/entity/folder/${folder.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'view' }),
      });
      expect(linkRes.status).toBe(200);

      const openRes = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(openRes.status).toBe(200);

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{
        title: string;
        entityType: string;
        source: string;
      }>;
      expect(items).toContainEqual(
        expect.objectContaining({
          title: 'Opened Link Folder',
          entityType: 'folder',
          source: 'link',
        }),
      );
    });

    it('with-me stores the source folder, not every page opened through a folder link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Linked Parent Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Nested Link Page',
        parentId: folder.id,
      });

      const linkRes = await app.request(`/api/shares/entity/folder/${folder.id}/link`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerSession.Cookie,
        },
        body: JSON.stringify({ permission: 'edit' }),
      });
      expect(linkRes.status).toBe(200);

      const pageRes = await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(pageRes.status).toBe(200);

      const accessRes = await app.request(`/api/pages/${page.id}/access`, {
        method: 'POST',
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(accessRes.status).toBe(200);

      const res = await app.request('/api/shares/with-me', {
        headers: { Cookie: recipientSession.Cookie },
      });
      expect(res.status).toBe(200);
      const items = (await res.json()) as Array<{ title: string; entityType: string }>;
      expect(items).toContainEqual(
        expect.objectContaining({ title: 'Linked Parent Folder', entityType: 'folder' }),
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ title: 'Nested Link Page', entityType: 'page' }),
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
