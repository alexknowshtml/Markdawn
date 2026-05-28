import { describe, expect, it } from 'vitest';
import { createTestApp, createTestSession, createTestUser } from '../test-utils';

describe('markdown import API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/markdown', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid session token', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: 'better-auth.session_token=invalid-token' },
      });
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

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('Hello World');
    });

    it('imports markdown with frontmatter', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const content = `---
title: Frontmatter Title
---

# Hello

Body text`;
      const formData = new FormData();
      formData.append('file', new File([content], 'note.md', { type: 'text/markdown' }));

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('Frontmatter Title');
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

    it('returns 400 for non-markdown file', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);

      const formData = new FormData();
      formData.append('file', new File(['plain text'], 'note.txt', { type: 'text/plain' }));

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
    });
  });
});
