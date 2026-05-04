import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

describe('export API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/workspaces/some-id/export');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/workspaces/some-id/export', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/workspaces/:workspaceId/export', () => {
    it('exports workspace as ZIP', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);
      await createTestPage(ws.id, user.id);

      const res = await app.request(`/api/workspaces/${ws.id}/export`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/zip');
      expect(res.headers.get('Content-Disposition')).toContain('workspace-export.zip');
    });

    it('exports empty workspace as ZIP', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);

      const res = await app.request(`/api/workspaces/${ws.id}/export`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/zip');
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const session2 = await createTestSession(user2.id);

      const res = await app.request(`/api/workspaces/${user1.workspaceId}/export`, {
        headers: { Cookie: session2.Cookie },
      });

      expect(res.status).toBe(403);
    });

    it('does not include deleted pages in export', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);
      const page = await createTestPage(ws.id, user.id, { title: 'Deleted' });

      await app.request(`/api/pages/${page.id}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie, Origin: 'http://localhost:5173' },
      });

      const res = await app.request(`/api/workspaces/${ws.id}/export`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/zip');
    });
  });
});
