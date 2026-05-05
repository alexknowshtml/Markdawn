import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Server } from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createCollabServer } from './server';
import {
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspace,
  createTestYjsDoc,
  getTestPool,
  insertTestWorkspace,
} from './test-utils';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function mockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as ReturnType<typeof import('@logtape/logtape').getLogger>;
}

describe('collab server', () => {
  const pool = getTestPool();
  const logger = mockLogger();

  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createCollabServer({ port: 0, pool, logger, debounceMs: 50, maxDebounceMs: 100 });
    await server.listen();
    port = (server as unknown as { address: { port: number } }).address.port;
  });

  afterAll(async () => {
    server.hocuspocus.closeConnections();
    server.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await pool.end();
  });

  describe('onAuthenticate', () => {
    it('allows connection with a valid session token', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: crypto.randomUUID(),
        document: new Y.Doc(),
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');
      expect(provider.isAuthenticated).toBe(true);
      provider.destroy();
    });

    it('rejects connection without a token', async () => {
      const authResult = await new Promise<'failed' | 'timeout'>((resolve) => {
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: crypto.randomUUID(),
          document: new Y.Doc(),
          onAuthenticationFailed: () => {
            provider.destroy();
            resolve('failed');
          },
        });

        setTimeout(() => {
          provider.destroy();
          resolve('timeout');
        }, 5_000);
      });

      expect(authResult).toBe('failed');
    });

    it('rejects connection with an invalid token', async () => {
      const authResult = await new Promise<'failed' | 'timeout'>((resolve) => {
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: crypto.randomUUID(),
          document: new Y.Doc(),
          token: 'this-token-does-not-exist',
          onAuthenticationFailed: () => {
            provider.destroy();
            resolve('failed');
          },
        });

        setTimeout(() => {
          provider.destroy();
          resolve('timeout');
        }, 5_000);
      });

      expect(authResult).toBe('failed');
    });

    it('rejects connection with an expired session token', async () => {
      const user = await createTestUser(pool);
      const sessionId = crypto.randomUUID();
      const token = crypto.randomUUID();

      await pool.query(
        `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
         VALUES ($1, $2, NOW() - INTERVAL '1 day', NOW(), NOW(), $3)`,
        [sessionId, token, user.id],
      );

      const authResult = await new Promise<'failed' | 'timeout'>((resolve) => {
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: crypto.randomUUID(),
          document: new Y.Doc(),
          token,
          onAuthenticationFailed: () => {
            provider.destroy();
            resolve('failed');
          },
        });

        setTimeout(() => {
          provider.destroy();
          resolve('timeout');
        }, 5_000);
      });

      expect(authResult).toBe('failed');
    });
  });

  describe('authorization', () => {
    it('denies access to another users page on load', async () => {
      const owner = await createTestUser(pool);
      const intruder = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, owner.id);
      const page = await createTestPage(pool, workspace.id, owner.id);
      const intruderSession = await createTestSession(pool, intruder.id);

      const authResult = await new Promise<'failed' | 'timeout'>((resolve) => {
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: new Y.Doc(),
          token: intruderSession.token,
          onAuthenticationFailed: () => {
            provider.destroy();
            resolve('failed');
          },
        });

        setTimeout(() => {
          provider.destroy();
          resolve('timeout');
        }, 5_000);
      });

      expect(authResult).toBe('failed');
    });

    it('denies edits to another users page on store', async () => {
      const owner = await createTestUser(pool);
      const intruder = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, owner.id);
      const page = await createTestPage(pool, workspace.id, owner.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const intruderSession = await createTestSession(pool, intruder.id);

      const ownerDoc = new Y.Doc();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: ownerDoc,
        token: ownerSession.token,
      });

      await waitFor(() => ownerProvider.synced, 5_000, 'owner provider to sync');
      ownerDoc.getText('content').insert(0, 'Owner content');
      ownerProvider.destroy();

      const authResult = await new Promise<'failed' | 'timeout'>((resolve) => {
        const intruderProvider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: new Y.Doc(),
          token: intruderSession.token,
          onAuthenticationFailed: () => {
            intruderProvider.destroy();
            resolve('failed');
          },
        });

        setTimeout(() => {
          intruderProvider.destroy();
          resolve('timeout');
        }, 5_000);
      });

      expect(authResult).toBe('failed');
    });
  });

  describe('onLoadDocument', () => {
    it('creates a new document when the page has no stored ydoc', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc,
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');
      expect(doc.getText('content').toString()).toBe('');
      provider.destroy();
    });

    it('loads existing ydoc from the database', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const ydocBytes = createTestYjsDoc('Hello from DB');
      const page = await createTestPage(pool, workspace.id, user.id, ydocBytes);
      const session = await createTestSession(pool, user.id);

      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc,
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');
      expect(doc.getText('content').toString()).toBe('Hello from DB');
      provider.destroy();
    });

    it('serves the same content to two concurrent readers', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const ydocBytes = createTestYjsDoc('Shared document');
      const page = await createTestPage(pool, workspace.id, user.id, ydocBytes);
      const session = await createTestSession(pool, user.id);

      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc1,
        token: session.token,
      });

      const provider2 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc2,
        token: session.token,
      });

      await waitFor(() => provider1.synced && provider2.synced, 5_000, 'both providers to sync');
      expect(doc1.getText('content').toString()).toBe('Shared document');
      expect(doc2.getText('content').toString()).toBe('Shared document');

      provider1.destroy();
      provider2.destroy();
    });
  });

  describe('onStoreDocument', () => {
    it('persists content edits to the database', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc,
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');

      doc.getText('content').insert(0, 'Persisted content');

      await waitFor(
        async () => {
          const res = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
          return res.rows[0]?.ydoc !== null;
        },
        5_000,
        'content to persist',
      );

      const result = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);

      const loadedDoc = new Y.Doc();
      Y.applyUpdate(loadedDoc, new Uint8Array(result.rows[0].ydoc as Buffer));
      expect(loadedDoc.getText('content').toString()).toBe('Persisted content');

      provider.destroy();
    });

    it('loads previously persisted content on reconnection', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const doc1 = new Y.Doc();
      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc1,
        token: session.token,
      });

      await waitFor(() => provider1.synced, 5_000, 'provider1 to sync');
      doc1.getText('content').insert(0, 'Round trip content');

      await waitFor(
        async () => {
          const res = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
          return res.rows[0]?.ydoc !== null;
        },
        5_000,
        'content to persist',
      );

      provider1.destroy();

      const doc2 = new Y.Doc();
      const provider2 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc2,
        token: session.token,
      });

      await waitFor(() => provider2.synced, 5_000, 'provider2 to sync');
      expect(doc2.getText('content').toString()).toBe('Round trip content');

      provider2.destroy();
    });
  });

  describe('onDisconnect', () => {
    it('force-saves document when provider disconnects before debounce', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc,
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');
      doc.getText('content').insert(0, 'Disconnect save');
      provider.destroy();

      await waitFor(
        async () => {
          const res = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
          return res.rows[0]?.ydoc !== null;
        },
        5_000,
        'disconnect force save',
      );

      const result = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
      const loadedDoc = new Y.Doc();
      Y.applyUpdate(loadedDoc, new Uint8Array(result.rows[0].ydoc as Buffer));
      expect(loadedDoc.getText('content').toString()).toBe('Disconnect save');
    });
  });

  describe('Yjs convergence', () => {
    it('converges concurrent edits from two providers', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc1,
        token: session.token,
      });

      const provider2 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: doc2,
        token: session.token,
      });

      await waitFor(() => provider1.synced && provider2.synced, 5_000, 'both providers to sync');

      doc1.getText('content').insert(0, 'Hello ');
      doc2.getText('content').insert(6, 'World');

      await waitFor(
        () => doc1.getText('content').toString() === doc2.getText('content').toString(),
        5_000,
        'documents to converge',
      );

      const text1 = doc1.getText('content').toString();
      const text2 = doc2.getText('content').toString();
      expect(text1).toBe(text2);
      expect(text1).toContain('Hello');
      expect(text1).toContain('World');

      provider1.destroy();
      provider2.destroy();
    });
  });
});
