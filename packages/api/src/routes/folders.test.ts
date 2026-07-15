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

describe('folders API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/folders/tree');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/folders/tree', () => {
    it('returns folder tree for the user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestFolder(user.id);

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('marks roots available through workspace membership', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const member = await createTestUser();
      const session = await createTestSession(member.id);
      const folder = await createTestFolder(owner.id);
      await createTestWorkspaceMember(owner.id, member.id, 'editor');

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toContainEqual(
        expect.objectContaining({
          id: folder.id,
          workspaceAccess: true,
          userPermission: 'edit',
        }),
      );
    });
  });

  describe('POST /api/folders', () => {
    it('creates a folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'New Folder' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Folder');
    });

    it('creates a nested folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: parent.id, name: 'Child' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.parentId).toBe(parent.id);
    });

    it('returns 404 for non-existent parent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          parentId: '00000000-0000-0000-0000-000000000000',
          name: 'Orphan',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects writes beneath a folder deleted after the caller checked it', async () => {
      const user = await createTestUser();
      const parent = await createTestFolder(user.id);
      await query('update folders set is_deleted = true, deleted_at = now() where id = $1', [
        parent.id,
      ]);

      await expect(
        query(
          `insert into folders (parent_id, name, position, created_by)
           values ($1, 'Too late', '0', $2)`,
          [parent.id, user.id],
        ),
      ).rejects.toThrow('Cannot place content inside a deleted folder');
    });

    it('requires admin access to create a nested folder', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const parent = await createTestFolder(owner.id);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [parent.id, owner.id, editor.id],
      );

      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: parent.id, name: 'Not allowed' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/folders/:id', () => {
    it('returns a specific folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Specific' });

      const res = await app.request(`/api/folders/${folder.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Specific');
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns public folder children without a session', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const folder = await createTestFolder(owner.id, { name: 'Public Folder' });
      const page = await createTestPage(owner.id, { parentId: folder.id, title: 'Child Page' });
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

      const res = await app.request(`/api/folders/${folder.id}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Public Folder');
      expect(body.linkPermission).toBe('view');
      expect(body.pages.some((p: { id: string }) => p.id === page.id)).toBe(true);
    });

    it('allows anonymous access to descendant folders through an ancestor folder link', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const parent = await createTestFolder(owner.id, { name: 'Public Parent' });
      const child = await createTestFolder(owner.id, { name: 'Public Child', parentId: parent.id });
      const token = crypto.randomUUID();

      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        parent.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [parent.id, owner.id, token],
      );

      const res = await app.request(`/api/folders/${child.id}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Public Child');
      expect(body.isPublic).toBe(true);
      expect(body.linkPermission).toBe('view');
    });
  });

  describe('PATCH /api/folders/:id', () => {
    it('updates a folder name', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Old' });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('rejects a non-numeric folder position', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ position: 'not-a-number' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_POSITION' });
    });

    it('does not let editors rename folders', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const editor = await createTestUser();
      const session = await createTestSession(editor.id);
      const folder = await createTestFolder(owner.id, { name: 'Original' });
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [folder.id, owner.id, editor.id],
      );

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ name: 'Not allowed' }),
      });

      expect(res.status).toBe(403);
    });

    it('prevents setting parent to self', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: folder.id }),
      });

      expect(res.status).toBe(400);
    });

    it('prevents deep cycle (moving ancestor into descendant)', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id, { name: 'Parent' });
      const child = await createTestFolder(user.id, {
        name: 'Child',
        parentId: parent.id,
      });

      const res = await app.request(`/api/folders/${parent.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: child.id }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects moving into a deleted folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Target' });
      const deleted = await createTestFolder(user.id, { name: 'Deleted' });

      await app.request(`/api/folders/${deleted.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: deleted.id }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects moving a shared folder into a folder the caller cannot edit', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const collaborator = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(collaborator.id);
      const folder = await createTestFolder(owner.id, { name: 'Shared' });
      const forbiddenParent = await createTestFolder(otherOwner.id, { name: 'Forbidden' });

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'edit')`,
        [folder.id, owner.id, collaborator.id],
      );

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ parentId: forbiddenParent.id }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Ghost' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/folders/:id/copy', () => {
    it('copies a folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id, { name: 'Original' });

      const res = await app.request(`/api/folders/${folder.id}/copy`, {
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
      expect(body.name).toContain('Copy of');
    });

    it('copies page connection indexes and occurrences', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      const page = await createTestPage(user.id, { parentId: folder.id, title: 'Tagged' });
      const connection = await query<{ id: string }>(
        `INSERT INTO connections (
           source_type, source_id, target_type, target_slug, target_label,
           connection_type, link_text, link_context, occurrence_count
         ) VALUES ('page', $1, 'tag', '#roadmap', '#roadmap', 'tag', '#roadmap', 'context', 1)
         RETURNING id`,
        [page.id],
      );
      await query(
        `INSERT INTO connection_occurrences (connection_id, source_block_id, position, context)
         VALUES ($1, 'block-1', 12, 'occurrence context')`,
        [connection.rows[0]?.id],
      );

      const res = await app.request(`/api/folders/${folder.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });
      const copiedFolder = (await res.json()) as { id: string };
      const copiedPage = await query<{ id: string }>(
        'SELECT id FROM pages WHERE parent_id = $1 AND title = $2',
        [copiedFolder.id, 'Copy of Tagged'],
      );
      const copiedIndex = await query<{
        source_block_id: string | null;
        position: number | null;
        context: string | null;
      }>(
        `SELECT occurrence.source_block_id, occurrence.position, occurrence.context
         FROM connections connection
         JOIN connection_occurrences occurrence ON occurrence.connection_id = connection.id
         WHERE connection.source_id = $1 AND connection.target_slug = '#roadmap'`,
        [copiedPage.rows[0]?.id],
      );

      expect(res.status).toBe(201);
      expect(copiedIndex.rows).toEqual([
        { source_block_id: 'block-1', position: 12, context: 'occurrence context' },
      ]);
    });

    it('lets viewers copy accessible content while skipping restricted descendants', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const viewer = await createTestUser();
      const session = await createTestSession(viewer.id);
      const root = await createTestFolder(owner.id, { name: 'Shared Root' });
      const restricted = await createTestFolder(owner.id, {
        name: 'Restricted Child',
        parentId: root.id,
      });
      await createTestPage(owner.id, { title: 'Private Child', parentId: restricted.id });
      await query("UPDATE folders SET inheritance_policy = 'restricted' WHERE id = $1", [
        restricted.id,
      ]);
      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('folder', $1, $2, $3, 'view')`,
        [root.id, owner.id, viewer.id],
      );

      const res = await app.request(`/api/folders/${root.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.skippedRestrictedItems).toBe(true);
      const privateCopy = await query('SELECT id FROM pages WHERE title = $1 AND created_by = $2', [
        'Copy of Private Child',
        viewer.id,
      ]);
      expect(privateCopy.rowCount).toBe(0);
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/folders/:id', () => {
    it('soft-deletes an empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('deletes a parent after its child was already soft-deleted', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const parent = await createTestFolder(user.id, { name: 'Parent' });
      const child = await createTestFolder(user.id, { name: 'Child', parentId: parent.id });

      const childRes = await app.request(`/api/folders/${child.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });
      expect(childRes.status).toBe(200);

      const parentRes = await app.request(`/api/folders/${parent.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(parentRes.status).toBe(200);
      expect(await parentRes.json()).toEqual({ deleted: true });
    });

    it('requires force flag for non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      await createTestPage(user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'FOLDER_NOT_EMPTY', requiresForce: true });
    });

    it('force-deletes a non-empty folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const folder = await createTestFolder(user.id);
      await createTestPage(user.id, { parentId: folder.id });

      const res = await app.request(`/api/folders/${folder.id}?force=true`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('rolls back every descendant when a forced deletion fails', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const root = await createTestFolder(user.id, { name: 'Root' });
      const child = await createTestFolder(user.id, { name: 'Child', parentId: root.id });
      const page = await createTestPage(user.id, { title: 'Fail deletion', parentId: child.id });

      await query(`
        CREATE OR REPLACE FUNCTION reject_test_page_deletion() RETURNS trigger AS $$
        BEGIN
          IF NEW.is_deleted = true AND NEW.title = 'Fail deletion' THEN
            RAISE EXCEPTION 'forced deletion failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_test_page_deletion_trigger
        BEFORE UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION reject_test_page_deletion();
      `);

      try {
        const res = await app.request(`/api/folders/${root.id}?force=true`, {
          method: 'DELETE',
          headers: { Cookie: session.Cookie },
        });
        expect(res.status).toBe(500);

        const folders = await query<{ id: string; is_deleted: boolean }>(
          'SELECT id, is_deleted FROM folders WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[root.id, child.id]],
        );
        expect(folders.rows.every((row) => row.is_deleted === false)).toBe(true);
        const storedPage = await query<{ is_deleted: boolean }>(
          'SELECT is_deleted FROM pages WHERE id = $1',
          [page.id],
        );
        expect(storedPage.rows[0]?.is_deleted).toBe(false);
      } finally {
        await query('DROP TRIGGER IF EXISTS reject_test_page_deletion_trigger ON pages');
        await query('DROP FUNCTION IF EXISTS reject_test_page_deletion()');
      }
    });

    it('returns 404 for non-existent folder', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });
  });
});
