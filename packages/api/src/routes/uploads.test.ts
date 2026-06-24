import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';

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

      const formData = new FormData();
      formData.append('file', new File(['fake-image-data'], 'test.png', { type: 'image/png' }));

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

      const formData = new FormData();
      formData.append('file', new File(['text'], 'test.txt', { type: 'text/plain' }));

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

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
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

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const formData = new FormData();
      formData.append('file', new File([binaryData], 'real.png', { type: 'image/png' }));

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
  });
});
