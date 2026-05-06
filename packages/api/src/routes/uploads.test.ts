import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestSession,
  createTestUser,
  createTestWorkspace,
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

      const formData = new FormData();
      formData.append('workspaceId', user.workspaceId);
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
      formData.append('workspaceId', user.workspaceId);
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

      const formData = new FormData();
      formData.append('workspaceId', user.workspaceId);

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const formData = new FormData();
      formData.append('file', new File(['fake'], 'test.png', { type: 'image/png' }));

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);

      const formData = new FormData();
      formData.append('workspaceId', ws.id);
      formData.append('file', new File(['fake'], 'test.png', { type: 'image/png' }));

      const res = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session2.Cookie },
        body: formData,
      });

      expect(res.status).toBe(403);
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

    it('returns 403 when user is not a workspace member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session1 = await createTestSession(user1.id);
      const session2 = await createTestSession(user2.id);
      const ws = await createTestWorkspace(user1.id);

      const formData = new FormData();
      formData.append('workspaceId', ws.id);
      formData.append('file', new File(['fake'], 'test.png', { type: 'image/png' }));

      const uploadRes = await app.request('/api/uploads', {
        method: 'POST',
        headers: { Cookie: session1.Cookie },
        body: formData,
      });
      const { url } = await uploadRes.json();

      const res = await app.request(url, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('returns uploaded file bytes with correct Content-Type', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const formData = new FormData();
      formData.append('workspaceId', user.workspaceId);
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
  });
});
