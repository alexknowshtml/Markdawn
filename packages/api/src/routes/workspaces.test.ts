import { describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestSession,
  createTestUser,
  createTestWorkspace,
} from '../test-utils';

describe('workspaces API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/workspaces');
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/workspaces', {
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/workspaces', () => {
    it('lists workspaces for the authenticated user', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/workspaces', () => {
    it('creates a new workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'My New Workspace' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('My New Workspace');
    });

    it('returns 400 when name is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/workspaces/:slug', () => {
    it('returns workspace details with members', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);

      const res = await app.request(`/api/workspaces/${ws.slug}`, {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workspace.name).toBe(ws.name);
      expect(Array.isArray(body.members)).toBe(true);
      expect(body.currentUserRole).toBe('owner');
    });

    it('returns 404 for non-existent workspace slug', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces/non-existent-slug', {
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/workspaces/:slug', () => {
    it('updates workspace name', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);

      const res = await app.request(`/api/workspaces/${ws.slug}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Name');
    });

    it('returns 404 for non-existent slug', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces/non-existent', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ name: 'Nope' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/workspaces/:slug', () => {
    it('deletes workspace when user is owner', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);

      const res = await app.request(`/api/workspaces/${ws.slug}`, {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 for non-existent slug', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/workspaces/non-existent', {
        method: 'DELETE',
        headers: { Cookie: session.Cookie },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/workspaces/:slug/members', () => {
    it('adds a member by email', async () => {
      const app = await createTestApp();
      const owner = await createTestUser();
      const newMember = await createTestUser();
      const session = await createTestSession(owner.id);
      const ws = await createTestWorkspace(owner.id);

      const res = await app.request(`/api/workspaces/${ws.slug}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ email: newMember.email }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 400 when email is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const ws = await createTestWorkspace(user.id);

      const res = await app.request(`/api/workspaces/${ws.slug}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.Cookie,
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
