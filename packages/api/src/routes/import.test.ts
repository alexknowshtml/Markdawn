import { MAX_YDOC_BYTES } from '@markdawn/shared';
import { extractConnectionsFromYDoc } from '@markdawn/shared/yjs-helpers';
import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
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

    it('resolves wiki links only within the importing user workspace', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const otherOwner = await createTestUser();
      const session = await createTestSession(user.id);
      const ownTarget = await createTestPage(user.id, { title: 'Roadmap' });
      await createTestPage(otherOwner.id, { title: 'Roadmap' });
      const formData = new FormData();
      formData.append(
        'file',
        new File(['# Imported\n\nSee [[Roadmap]]'], 'imported.md', { type: 'text/markdown' }),
      );

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const imported = (await res.json()) as { id: string };
      const ydocResult = await query<{ ydoc: Buffer }>('SELECT ydoc FROM pages WHERE id = $1', [
        imported.id,
      ]);
      const connections = extractConnectionsFromYDoc(
        new Uint8Array(ydocResult.rows[0]?.ydoc ?? []),
      );
      expect(connections).toContainEqual(
        expect.objectContaining({ targetId: ownTarget.id, targetSlug: 'roadmap' }),
      );
    });

    it('prefers exact workspace paths and leaves ambiguous titles unresolved', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      await createTestPage(user.id, { title: 'Roadmap' });
      const plans = await createTestFolder(user.id, { name: 'Plans' });
      const pathTarget = await createTestPage(user.id, {
        title: 'Roadmap',
        parentId: plans.id,
      });
      const formData = new FormData();
      formData.append(
        'file',
        new File(
          ['# Imported\n\nExact [[Plans/Roadmap]] and ambiguous [[Roadmap]]'],
          'imported.md',
          { type: 'text/markdown' },
        ),
      );

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const imported = (await res.json()) as { id: string };
      const ydocResult = await query<{ ydoc: Buffer }>('SELECT ydoc FROM pages WHERE id = $1', [
        imported.id,
      ]);
      const connections = extractConnectionsFromYDoc(
        new Uint8Array(ydocResult.rows[0]?.ydoc ?? []),
      );
      expect(connections).toContainEqual(
        expect.objectContaining({ targetSlug: 'plans/roadmap', targetId: pathTarget.id }),
      );
      const ambiguous = connections.find((connection) => connection.targetSlug === 'roadmap');
      expect(ambiguous?.targetId).toBeUndefined();
    });

    it('rejects oversized markdown before creating a page', async () => {
      const app = await createTestApp();
      const user = await createTestUser();
      const session = await createTestSession(user.id);
      const formData = new FormData();
      formData.append(
        'file',
        new File([new Uint8Array(MAX_YDOC_BYTES + 1)], 'oversized.md', {
          type: 'text/markdown',
        }),
      );

      const res = await app.request('/api/import/markdown', {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: formData,
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
      const pages = await query<{ count: string }>(
        'select count(*)::text as count from pages where created_by = $1',
        [user.id],
      );
      expect(pages.rows[0]?.count).toBe('0');
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
