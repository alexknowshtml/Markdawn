import { describe, expect, it } from 'vitest';
import { createTestApp, createTestSession, createTestUser } from '../test-utils';

describe('obsidian import API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/obsidian', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/import/obsidian', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty import request', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const otherUser = await createTestUser();

      const res = await app.request(`/api/import/obsidian?workspaceId=${otherUser.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ path: 'note.md', content: '# Hello' }],
        }),
      });

      expect(res.status).toBe(403);
    });

    it('imports a simple markdown file (happy path)', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ path: 'note.md', content: '# Hello\n\nWorld' }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.pagesCreated).toBeGreaterThanOrEqual(1);
    });

    it('imports nested folders', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            { path: 'Projects/note.md', content: '# Project Note' },
            { path: 'Projects/Subproject/note2.md', content: '# Subproject Note' },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.foldersCreated).toBeGreaterThanOrEqual(2);
      expect(body.pagesCreated).toBe(2);
    });

    it('imports tags from frontmatter', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            {
              path: 'tagged.md',
              content: '---\ntags:\n  - review\n  - urgent\n---\n\n# Tagged Note',
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.pagesCreated).toBeGreaterThanOrEqual(1);
    });

    it('imports images as base64', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            { path: 'note.md', content: '# Note' },
            {
              path: 'image.png',
              data: Buffer.from('fake-image').toString('base64'),
              mimeType: 'image/png',
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.imagesUploaded).toBeGreaterThanOrEqual(1);
    });

    it('creates backlinks between pages', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            { path: 'page-a.md', content: '# Page A\n\nSee [[Page B]] for details' },
            { path: 'page-b.md', content: '# Page B\n\nBacklink target' },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.backlinksCreated).toBeGreaterThanOrEqual(1);
    });

    it('handles invalid body gracefully', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
    });

    it('handles missing files field', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const res = await app.request(`/api/import/obsidian?workspaceId=${user.workspaceId}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
