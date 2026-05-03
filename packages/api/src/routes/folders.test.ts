import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestPageLink,
  createTestSession,
  createTestUser,
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
    it('returns folder tree for workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestFolder(user.workspaceId, user.id);

      const res = await app.request(`/api/folders/tree?workspaceId=${user.workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/folders/tree', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(400);
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
        body: JSON.stringify({ workspaceId: user.workspaceId, name: 'New Folder' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Folder');
    });
  });
});

describe('backlinks API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/backlinks?pageId=some-id');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/backlinks', () => {
    it('returns incoming backlinks for a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.workspaceId, user.id);
      const page2 = await createTestPage(user.workspaceId, user.id);
      await createTestPageLink(page1.id, page2.id);

      const res = await app.request(`/api/backlinks?pageId=${page2.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns outgoing links', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const page1 = await createTestPage(user.workspaceId, user.id);
      const page2 = await createTestPage(user.workspaceId, user.id);
      await createTestPageLink(page1.id, page2.id);

      const res = await app.request(`/api/backlinks/outgoing?pageId=${page1.id}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
