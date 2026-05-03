import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTestApp,
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
  });
});
