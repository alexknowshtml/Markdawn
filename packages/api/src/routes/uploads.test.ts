import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestPublicShare,
  createTestSession,
  createTestUser,
} from '../test-utils';

describe('uploads API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/uploads', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/uploads', () => {
    it('uploads an image file', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const formData = new FormData();
      formData.append('file', new File(['fake-image-data'], 'test.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toMatch(/^\/api\/uploads\//);
    });

    it('returns 400 for unsupported file type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const formData = new FormData();
      formData.append('file', new File(['text'], 'test.txt', { type: 'text/plain' }));
      formData.append('pageId', page.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when file is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: (() => {
          const formData = new FormData();
          formData.append('pageId', page.id);
          return formData;
        })(),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/uploads/:filename', () => {
    it('returns 400 for invalid filename characters', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/uploads/file@name.png', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent file', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/uploads/nonexistent.png', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns uploaded file bytes with correct Content-Type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page = await createTestPage(user.id);

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'real.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = await uploadRes.json();

      const res = await app.request(url, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      const returned = new Uint8Array(await res.arrayBuffer());
      expect(returned).toEqual(binaryData);
    });

    it('allows recipients to fetch uploads from directly shared root pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const page = await createTestPage(owner.id, { title: 'Shared Root Page' });

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'shared-root.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      expect(uploadRes.status).toBe(200);
      const { url } = (await uploadRes.json()) as { url: string };

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const res = await app.request(url, {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
    });

    it('blocks users who only have access to a different page by the upload owner', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const recipientSession = await createTestSession(recipient.id);
      const uploadPage = await createTestPage(owner.id, { title: 'Upload Page' });
      const sharedPage = await createTestPage(owner.id, { title: 'Other Shared Page' });

      const formData = new FormData();
      formData.append(
        'file',
        new File([new Uint8Array([0x89, 0x50])], 'scoped.png', { type: 'image/png' }),
      );
      formData.append('pageId', uploadPage.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };

      await query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'view')`,
        [sharedPage.id, owner.id, recipient.id],
      );

      const res = await app.request(url, {
        headers: { Cookie: recipientSession.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('blocks anonymous downloads for private page uploads', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Private Page' });

      const formData = new FormData();
      formData.append(
        'file',
        new File([new Uint8Array([0x89, 0x50])], 'private.png', { type: 'image/png' }),
      );
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };

      const res = await app.request(url);

      expect(res.status).toBe(404);
    });

    it('allows anonymous downloads for public page uploads', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Public Page' });

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await createTestPublicShare(page.id);

      const res = await app.request(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(binaryData);
    });

    it('allows anonymous downloads for uploads in public folders', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id);
      const page = await createTestPage(owner.id, { parentId: folder.id });

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'folder-public.png', { type: 'image/png' }));
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        crypto.randomUUID(),
        folder.id,
      ]);

      const res = await app.request(url);

      expect(res.status).toBe(200);
    });

    it('blocks anonymous downloads for uploads on restricted public pages', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const page = await createTestPage(owner.id, { title: 'Restricted Public Page' });

      const formData = new FormData();
      formData.append(
        'file',
        new File([new Uint8Array([0x89, 0x50])], 'restricted-public.png', { type: 'image/png' }),
      );
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await createTestPublicShare(page.id);
      await query('UPDATE pages SET is_access_restricted = true WHERE id = $1', [page.id]);

      const res = await app.request(url);

      expect(res.status).toBe(404);
    });

    it('blocks anonymous downloads for uploads in folders under restricted ancestor', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const rootFolder = await createTestFolder(owner.id);
      const childFolder = await createTestFolder(owner.id, { parentId: rootFolder.id });
      const page = await createTestPage(owner.id, { parentId: childFolder.id });

      const formData = new FormData();
      formData.append(
        'file',
        new File([new Uint8Array([0x89, 0x50])], 'restricted-ancestor.png', { type: 'image/png' }),
      );
      formData.append('pageId', page.id);

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: ownerSession.Cookie },
        body: formData,
      });
      const { url } = (await uploadRes.json()) as { url: string };
      await query('UPDATE folders SET is_public = true, public_token = $1 WHERE id = $2', [
        crypto.randomUUID(),
        rootFolder.id,
      ]);
      await query('UPDATE folders SET is_access_restricted = true WHERE id = $1', [childFolder.id]);

      const res = await app.request(url);

      expect(res.status).toBe(404);
    });
  });
});
