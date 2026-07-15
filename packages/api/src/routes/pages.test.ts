import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';

async function addFolderShare(folderId: string, recipientUserId: string, permission = 'view') {
  await query(
    `INSERT INTO shares (entity_type, entity_id, recipient_user_id, permission, token)
     VALUES ('folder', $1, $2, $3, NULL)`,
    [folderId, recipientUserId, permission],
  );
}

describe('pages API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/tree');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/pages', () => {
    it('creates a page with valid data', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          title: 'My Test Page',
        }),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body.title).toBe('My Test Page');
      expect(body.id).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      expect(body.updatedAt).toBeTruthy();
    });

    it('creates after a sibling with a position beyond JavaScript safe numeric formatting', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const existing = await createTestPage(user.id);
      await query('update pages set position = $1 where id = $2', [
        '1000000000000000000000',
        existing.id,
      ]);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'After large position' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.position).toBe('1000000000000000000001');
    });

    it('returns 404 for non-existent parentId', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          title: 'Orphan Page',
          parentId: '00000000-0000-0000-0000-000000000000',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('requires admin access to create inside a shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const folder = await createTestFolder(owner.id);
      await addFolderShare(folder.id, editor.id, 'edit');

      const res = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'Not allowed', parentId: folder.id }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/pages/tree', () => {
    it('returns pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      await createTestPage(user.id, { title: 'Page 1' });
      await createTestPage(user.id, { title: 'Page 2' });

      const res = await app.request(`/api/pages/tree`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body.map((p: { title: string }) => p.title).sort()).toEqual(['Page 1', 'Page 2']);
      expect(body[0]).toHaveProperty('id');
    });

    it("includes root workspace owner's pages for workspace members", async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const session = await createTestSession(member.id);
      const page = await createTestPage(owner.id, { title: 'Workspace Root Page' });
      await createTestWorkspaceMember(owner.id, member.id, 'viewer');

      const res = await app.request('/api/pages/tree', {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const workspacePage = body.find((p: { id: string }) => p.id === page.id);
      expect(workspacePage).toMatchObject({ workspaceAccess: true, userPermission: 'view' });
    });

    it('includes pages under directly shared folders for folder share recipients', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Page in Shared Folder',
        parentId: folder.id,
      });
      await addFolderShare(folder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('includes pages under inherited shared folders for folder share recipients', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const parentFolder = await createTestFolder(owner.id, { name: 'Shared Parent' });
      const childFolder = await createTestFolder(owner.id, {
        name: 'Shared Child',
        parentId: parentFolder.id,
      });
      const page = await createTestPage(owner.id, {
        title: 'Page Under Shared Ancestor',
        parentId: childFolder.id,
      });
      await addFolderShare(parentFolder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('still includes pages directly in a non-restricted shared folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared Folder' });
      const page = await createTestPage(owner.id, {
        title: 'Page in Shared Folder',
        parentId: folder.id,
      });
      await addFolderShare(folder.id, recipient.id, 'view');

      const res = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });
  });

  describe('GET /api/pages/trash', () => {
    it('lists trashed pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'To Delete' });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/trash', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('uses folder owner, not creator, for child page trash control', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const collaboratorSession = await createTestSession(collaborator.id);
      const folder = await createTestFolder(owner.id, { name: 'Owner Folder' });
      const page = await createTestPage(collaborator.id, {
        title: 'Collaborator Child',
        parentId: folder.id,
      });

      const deleteRes = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(deleteRes.status).toBe(200);

      const ownerTrashRes = await app.request('/api/pages/trash', {
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(ownerTrashRes.status).toBe(200);
      const ownerTrash = (await ownerTrashRes.json()) as Array<{
        id: string;
        ownerId: string | null;
      }>;
      expect(ownerTrash).toContainEqual(
        expect.objectContaining({ id: page.id, ownerId: owner.id }),
      );

      const collaboratorTrashRes = await app.request('/api/pages/trash', {
        headers: { Cookie: collaboratorSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(collaboratorTrashRes.status).toBe(200);
      const collaboratorTrash = (await collaboratorTrashRes.json()) as Array<{ id: string }>;
      expect(collaboratorTrash).not.toContainEqual(expect.objectContaining({ id: page.id }));

      const collaboratorRestoreRes = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: collaboratorSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(collaboratorRestoreRes.status).toBe(403);

      const ownerRestoreRes = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(ownerRestoreRes.status).toBe(200);

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      const permanentRes = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(permanentRes.status).toBe(200);

      const pageRows = await query('select id from pages where id = $1', [page.id]);
      expect(pageRows.rowCount).toBe(0);
    });
  });

  describe('DELETE /api/pages/trash/empty-all', () => {
    it('empties all trashed pages', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/trash/empty-all', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
      expect(body.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/pages/export', () => {
    it('exports accessible pages from the mounted route', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestPage(user.id, { title: 'Exported Page' });

      const res = await app.request('/api/pages/export', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/zip');
      expect(res.headers.get('Content-Disposition')).toContain('markdawn-export.zip');
    });
  });

  describe('GET /api/pages/recent', () => {
    it('returns recent pages for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      await app.request(`/api/pages/${page.id}`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request('/api/pages/recent', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 400 for non-positive limit', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/recent?limit=0', {
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/pages/:id public access', () => {
    it('allows anonymous access to a page through a public ancestor folder link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, {
        parentId: folder.id,
        title: 'Inherited Public Page',
      });
      const token = crypto.randomUUID();

      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        folder.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [folder.id, owner.id, token],
      );

      const res = await app.request(`/api/pages/${page.id}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Inherited Public Page');
      expect(body.isPublic).toBe(true);
      expect(body.linkPermission).toBe('view');
    });
  });

  describe('PATCH /api/pages/:id/restore', () => {
    it('restores a soft-deleted page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/pages/${page.id}/restore`, {
        method: 'PATCH',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const _body = await res.json();
      const treeRes = await app.request('/api/pages/tree', {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      const tree = await treeRes.json();
      expect(tree.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });
  });

  describe('PATCH /api/pages/:id/move', () => {
    it('moves a page to a different parent', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Movable' });

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: null, position: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(page.id);
    });

    it('rejects a non-numeric move position without changing the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'a0' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
      const stored = await query<{ position: string }>('SELECT position FROM pages WHERE id = $1', [
        page.id,
      ]);
      expect(stored.rows[0]?.position).toBe('0');
    });

    it('rejects decimal positions that exceed the database precision bound', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);
      const oversizedPosition = `0.${'0'.repeat(128)}1`;

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: oversizedPosition }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('prevents moving page to itself', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: page.id }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects moving a shared page into a folder the caller cannot edit', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(collaborator.id);
      const page = await createTestPage(owner.id);
      const forbiddenFolder = await createTestFolder(otherOwner.id);

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, collaborator.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: forbiddenFolder.id }),
      });

      expect(res.status).toBe(403);
    });

    it('does not let editors move pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const sourceFolder = await createTestFolder(owner.id);
      const destinationFolder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'edit'), ('folder', $4, $3, $2, 'edit')`,
        [sourceFolder.id, editor.id, owner.id, destinationFolder.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(403);
    });

    it('lets admins move pages between folders owned by the same user', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const session = await createTestSession(admin.id);
      const sourceFolder = await createTestFolder(owner.id);
      const destinationFolder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'admin'), ('folder', $4, $3, $2, 'admin')`,
        [sourceFolder.id, admin.id, owner.id, destinationFolder.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(200);
    });

    it('blocks moves between different owners even when the caller is admin in both places', async () => {
      const app = await createTestApp();
      const sourceOwner = await createTestUser();
      const destinationOwner = await createTestUser();
      const admin = await createTestUser();
      const session = await createTestSession(admin.id);
      const sourceFolder = await createTestFolder(sourceOwner.id);
      const destinationFolder = await createTestFolder(destinationOwner.id);
      const page = await createTestPage(sourceOwner.id, { parentId: sourceFolder.id });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $3, $2, 'admin'), ('folder', $4, $5, $2, 'admin')`,
        [sourceFolder.id, admin.id, sourceOwner.id, destinationFolder.id, destinationOwner.id],
      );

      const res = await app.request(`/api/pages/${page.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: destinationFolder.id }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/pages/:id/export/markdown', () => {
    it('exports page content as markdown', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const page = await createTestPage(user.id, { title: 'Export' });

      const res = await app.request(`/api/pages/${page.id}/export/markdown`, {
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('export.md');
      const body = await res.text();
      expect(typeof body).toBe('string');
    });

    it('allows signed-in viewers to export a shared page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Shared Export' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/pages/${page.id}/export/markdown`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(
        '/api/pages/00000000-0000-0000-0000-000000000000/export/markdown',
        {
          headers: { Cookie: session.Cookie },
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pages/:id/import/markdown', () => {
    it('imports markdown via JSON body', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Import' });

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ markdown: '# New Content\n\nHello world' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 415 for unsupported content type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: 'plain text',
      });
      expect(res.status).toBe(415);
    });

    it('returns 400 for empty markdown', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/import/markdown`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ markdown: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/pages/:id/copy', () => {
    it('creates a copy of the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Original' });

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('Copy of Original');
      expect(body.id).not.toBe(page.id);
    });

    it('allows a viewer to copy a shared page into their own workspace', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const page = await createTestPage(owner.id, { title: 'Shared Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });

      expect(res.status).toBe(201);
      const copied = await res.json();
      expect(copied.createdBy).toBe(viewer.id);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/pages/:id/permanent', () => {
    it('permanently deletes a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/permanent`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/permanent', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/pages/:id', () => {
    it('returns a specific page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, {
        title: 'My Page',
      });

      const res = await app.request(`/api/pages/${page.id}`, {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('My Page');
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000', {
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/pages/:id', () => {
    it('updates a page title', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, {
        title: 'Original',
      });

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Updated Title');
    });

    it('renames pages whose titles exceed the PostgreSQL notification limit', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id, { title: 'Original' });
      const longTitle = 'T'.repeat(9000);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: longTitle }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).title).toBe(longTitle);
    });

    it('rejects a non-numeric page position', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'not-a-number' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('allows editors to update page content metadata', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const page = await createTestPage(owner.id, { title: 'Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'Edited', icon: 'x', properties: { tags: ['shared'] } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Edited');
      expect(body.icon).toBe('x');
    });

    it('returns 400 when setting parentId to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: page.id }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent parentId', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: '00000000-0000-0000-0000-000000000000' }),
      });
      expect(res.status).toBe(404);
    });

    it('updates properties as JSON', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ properties: { status: 'done', priority: 1 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.properties).toEqual({ status: 'done', priority: 1 });
    });
  });

  describe('DELETE /api/pages/:id', () => {
    it('soft-deletes a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });
  });

  describe('POST /api/pages/:id/leave', () => {
    it('returns 401 without session', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when user owns the page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Cannot leave your own page');
    });

    it('returns 404 for non-existent page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/pages/00000000-0000-0000-0000-000000000000/leave', {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(404);
    });

    it('removes share row for email-invited page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const session = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id);

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const shareCheck = await query(
        `SELECT id FROM shares WHERE entity_id = $1 AND recipient_user_id = $2`,
        [page.id, recipient.id],
      );
      expect(shareCheck.rowCount).toBe(0);
    });

    it('removes page_access_events row for link-joined page', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(owner.id);

      await query(
        `INSERT INTO page_access_events (page_id, user_id, source, token, permission, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'link', 'test-token', 'view', now(), now())`,
        [page.id, user.id],
      );

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);

      const paeCheck = await query(
        `SELECT id FROM page_access_events WHERE page_id = $1 AND user_id = $2`,
        [page.id, user.id],
      );
      expect(paeCheck.rowCount).toBe(0);
    });

    it('rejects leave requests with no direct share or link-access record', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const session = await createTestSession(stranger.id);
      const page = await createTestPage(owner.id);

      const res = await app.request(`/api/pages/${page.id}/leave`, {
        method: 'POST',
        headers: {
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
      });
      expect(res.status).toBe(409);
    });
  });
});
