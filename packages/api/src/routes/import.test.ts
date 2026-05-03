import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestSession,
  createTestUser,
} from '../test-utils';

describe('markdown import API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/markdown', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/import/markdown', () => {
    it('imports markdown content', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const formData = new FormData();
      formData.append('file', new File(['# Hello World'], 'note.md', { type: 'text/markdown' }));
      formData.append('workspaceId', user.workspaceId);

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(200);
    });

    it('returns 400 when file is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
    });
  });
});
