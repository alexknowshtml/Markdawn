import { describe, expect, it } from 'vitest';
import { createTestApp, createTestSession, createTestUser } from '../test-utils';

describe('obsidian import API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/obsidian', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/import/obsidian', () => {
    it('returns 400 for empty import request', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const formData = new FormData();
      formData.append('workspaceId', user.workspaceId);

      const res = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
        body: formData,
      });

      expect(res.status).toBe(400);
    });
  });
});
