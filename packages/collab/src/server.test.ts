import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  type ConnectionConfiguration,
  Document,
  type Server,
  type onAuthenticatePayload,
  type onDisconnectPayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createCollabServer } from './server';
import {
  createCorruptedYjsDoc,
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

function createConnectionConfig(): ConnectionConfiguration {
  return {
    readOnly: false,
    isAuthenticated: false,
  };
}

function createAuthenticatePayload(
  server: Server,
  overrides: Partial<onAuthenticatePayload> = {},
): onAuthenticatePayload {
  return {
    context: {},
    documentName: crypto.randomUUID(),
    instance: server.hocuspocus,
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    request: {} as onAuthenticatePayload['request'],
    socketId: crypto.randomUUID(),
    token: '',
    connectionConfig: createConnectionConfig(),
    ...overrides,
  };
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

    it('authenticates with bearer token from request headers', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        requestHeaders: {
          authorization: `Bearer ${session.token}`,
        },
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as { user: { id: string } };
      expect(authenticated.user.id).toBe(user.id);
    });

    it('authenticates with better-auth session cookie', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        requestHeaders: {
          cookie: `better-auth.session_token=${session.token}`,
        },
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as { user: { id: string } };
      expect(authenticated.user.id).toBe(user.id);
    });

    it('authenticates with secure better-auth session cookie', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        requestHeaders: {
          cookie: `__Secure-better-auth.session_token=${session.token}`,
        },
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as { user: { id: string } };
      expect(authenticated.user.id).toBe(user.id);
    });

    it('skips page access checks when document name is empty', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const querySpy = vi.spyOn(pool, 'query');

      const payload = createAuthenticatePayload(server, {
        documentName: '',
        token: session.token,
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as { user: { id: string } };
      expect(authenticated.user.id).toBe(user.id);
      expect(querySpy).not.toHaveBeenCalledWith('SELECT 1 FROM pages WHERE id = $1 LIMIT 1', ['']);
    });

    it('authenticates via WebSocket handshake with cookie header', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const websocketProvider = new HocuspocusProviderWebsocket({
        url: `ws://localhost:${port}`,
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string, protocols?: string | string[]) {
            const options = {
              headers: { cookie: `better-auth.session_token=${session.token}` },
            };
            if (protocols === undefined) {
              super(url, options);
              return;
            }
            super(url, protocols, options);
          }
        },
      });

      const provider = new HocuspocusProvider({
        name: crypto.randomUUID(),
        document: new Y.Doc(),
        websocketProvider,
      });

      try {
        provider.attach();
        await waitFor(() => provider.synced, 5_000, 'cookie-auth provider to sync');
        expect(provider.isAuthenticated).toBe(true);
      } finally {
        provider.destroy();
        websocketProvider.destroy();
      }
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

    it('logs access denial when user lacks workspace membership', async () => {
      const owner = await createTestUser(pool);
      const intruder = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, owner.id);
      const page = await createTestPage(pool, workspace.id, owner.id);
      const intruderSession = await createTestSession(pool, intruder.id);

      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
        token: intruderSession.token,
      });

      await expect(server.hocuspocus.hooks('onAuthenticate', payload)).rejects.toThrow('Forbidden');
      expect(logger.debug).toHaveBeenCalledWith(
        `[auth] user=${intruder.id} denied access to page=${page.id}`,
      );
    });
  });

  describe('onLoadDocument', () => {
    it('rejects loading when user context is missing', async () => {
      const payload: onLoadDocumentPayload = {
        context: {},
        document: new Document(crypto.randomUUID()),
        documentName: crypto.randomUUID(),
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      await expect(server.hocuspocus.hooks('onLoadDocument', payload)).rejects.toThrow(
        'Unauthorized',
      );
    });

    it('returns early for invalid non-uuid document names', async () => {
      const payload: onLoadDocumentPayload = {
        context: { user: { id: crypto.randomUUID() } },
        document: new Document('not-a-uuid'),
        documentName: 'not-a-uuid',
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      const result = await server.hocuspocus.hooks('onLoadDocument', payload);
      expect(result).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith('skipping non-meta, non-UUID room: not-a-uuid');
    });

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

    it('creates new document when stored ydoc is an empty buffer', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const pageId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO pages (id, workspace_id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
         VALUES ($1, $2, NULL, 'Empty Buffer Page', '0', $3, NOW(), NOW(), $4)`,
        [pageId, workspace.id, user.id, Buffer.alloc(0)],
      );

      const payload: onLoadDocumentPayload = {
        context: { user: { id: user.id } },
        document: new Document(pageId),
        documentName: pageId,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      const result = await server.hocuspocus.hooks('onLoadDocument', payload);
      expect(result).toBeUndefined();
    });

    it('logs info when page does not exist in the database', async () => {
      const nonExistentId = crypto.randomUUID();

      const payload: onLoadDocumentPayload = {
        context: { user: { id: crypto.randomUUID() } },
        document: new Document(nonExistentId),
        documentName: nonExistentId,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      const result = await server.hocuspocus.hooks('onLoadDocument', payload);
      expect(result).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(`New document: ${nonExistentId}`);
    });

    it('throws when stored ydoc contains corrupted binary data', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const corruptedData = createCorruptedYjsDoc();
      const pageId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO pages (id, workspace_id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
         VALUES ($1, $2, NULL, 'Corrupted Page', '0', $3, NOW(), NOW(), $4)`,
        [pageId, workspace.id, user.id, Buffer.from(corruptedData)],
      );

      const payload: onLoadDocumentPayload = {
        context: { user: { id: user.id } },
        document: new Document(pageId),
        documentName: pageId,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      await expect(server.hocuspocus.hooks('onLoadDocument', payload)).rejects.toThrow();
    });
  });

  describe('onStoreDocument', () => {
    it('rejects store when user context is missing', async () => {
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: {},
        document: new Document(crypto.randomUUID()),
        documentName: crypto.randomUUID(),
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(server.hocuspocus.hooks('onStoreDocument', payload)).rejects.toThrow(
        'Unauthorized',
      );
    });

    it('rethrows and logs when persistence update fails', async () => {
      const failingLogger = mockLogger();
      const mockClient = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          if (
            text.startsWith('update pages set ydoc') ||
            text.startsWith('update "pages" set "ydoc"')
          ) {
            throw new Error('forced db failure');
          }
          return pool.query(text, values);
        }),
        release: vi.fn(),
      };
      const failingPool = {
        connect: vi.fn(async () => mockClient),
        query: vi.fn(async (text: string, values?: unknown[]) => {
          return pool.query(text, values);
        }),
      } as unknown as typeof pool;
      const failingServer = createCollabServer({
        port: 0,
        pool: failingPool,
        logger: failingLogger,
        debounceMs: 50,
        maxDebounceMs: 100,
      });

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: crypto.randomUUID() } },
        document: new Document(crypto.randomUUID()),
        documentName: crypto.randomUUID(),
        instance: failingServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(failingServer.hocuspocus.hooks('onStoreDocument', payload)).rejects.toThrow(
        'forced db failure',
      );
      expect(failingLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`[persist] failed to save "${payload.documentName}"`),
      );
    });

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

    it('coalesces rapid edits into fewer persistence calls via debounce', async () => {
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

      // Spy on pool.connect calls — each persistDocument call acquires a client,
      // so connect call count reflects persistence write count.
      const connectSpy = vi.spyOn(pool, 'connect');

      const text = doc.getText('content');
      text.insert(0, 'Edit 1');
      await sleep(10);
      text.insert(6, ' Edit 2');
      await sleep(10);
      text.insert(13, ' Edit 3');
      await sleep(10);
      text.insert(20, ' Edit 4');
      await sleep(10);
      text.insert(27, ' Edit 5');

      await sleep(200);

      // 5 edits within debounce window should produce at most 4 persistence writes
      // (1 from debounced onStoreDocument + 1 from updateWorkspaceMeta's pool.query
      //  + possibly 1 from onDisconnect force-save + 1 from meta room sync)
      expect(connectSpy.mock.calls.length).toBeGreaterThan(0);
      expect(connectSpy.mock.calls.length).toBeLessThanOrEqual(4);

      // Final content in DB should reflect all edits
      const result = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
      const loadedDoc = new Y.Doc();
      Y.applyUpdate(loadedDoc, new Uint8Array(result.rows[0].ydoc as Buffer));
      const finalContent = loadedDoc.getText('content').toString();
      expect(finalContent).toContain('Edit 5');

      connectSpy.mockRestore();
      provider.destroy();
    });
  });

  describe('onDisconnect', () => {
    it('returns early when no in-memory document exists', async () => {
      const payload: onDisconnectPayload = {
        clientsCount: 0,
        context: { user: { id: crypto.randomUUID() } },
        document: new Document(crypto.randomUUID()),
        documentName: crypto.randomUUID(),
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(server.hocuspocus.hooks('onDisconnect', payload)).resolves.toBeUndefined();
    });

    it('logs persistence failures on disconnect without throwing', async () => {
      const failingLogger = mockLogger();
      const mockClient = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          if (
            text.startsWith('update pages set ydoc') ||
            text.startsWith('update "pages" set "ydoc"')
          ) {
            throw new Error('disconnect write failed');
          }
          return pool.query(text, values);
        }),
        release: vi.fn(),
      };
      const failingPool = {
        connect: vi.fn(async () => mockClient),
        query: vi.fn(async (text: string, values?: unknown[]) => {
          return pool.query(text, values);
        }),
      } as unknown as typeof pool;
      const failingServer = createCollabServer({
        port: 0,
        pool: failingPool,
        logger: failingLogger,
        debounceMs: 50,
        maxDebounceMs: 100,
      });

      const documentName = crypto.randomUUID();
      const doc = new Document(documentName);
      doc.getText('content').insert(0, 'pending');
      failingServer.hocuspocus.documents.set(documentName, doc);
      const payload: onDisconnectPayload = {
        clientsCount: 0,
        context: { user: { id: crypto.randomUUID() } },
        document: doc,
        documentName,
        instance: failingServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(
        failingServer.hocuspocus.hooks('onDisconnect', payload),
      ).resolves.toBeUndefined();
      expect(failingLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`[disconnect] force save failed for "${documentName}"`),
      );
      failingServer.hocuspocus.documents.delete(documentName);
    });

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

    it('handles disconnect gracefully for a fresh in-memory document', async () => {
      const documentName = crypto.randomUUID();
      const doc = new Document(documentName);
      server.hocuspocus.documents.set(documentName, doc);

      const payload: onDisconnectPayload = {
        clientsCount: 0,
        context: { user: { id: crypto.randomUUID() } },
        document: doc,
        documentName,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(server.hocuspocus.hooks('onDisconnect', payload)).resolves.toBeUndefined();

      server.hocuspocus.documents.delete(documentName);
    });
  });

  describe('Yjs convergence', () => {
    it('syncs awareness state between connected providers', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      const provider2 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      await waitFor(
        () => provider1.synced && provider2.synced,
        5_000,
        'awareness providers to sync',
      );
      provider1.setAwarenessField('user', { name: 'Provider One' });

      await waitFor(
        () => {
          for (const state of provider2.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Provider One') {
              return true;
            }
          }
          return false;
        },
        5_000,
        'awareness state propagation',
      );

      provider1.destroy();
      provider2.destroy();
    });

    it('re-syncs document state after a provider reconnects', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const providerA = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: docA,
        token: session.token,
      });
      const providerB = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: docB,
        token: session.token,
      });

      await waitFor(() => providerA.synced && providerB.synced, 5_000, 'initial provider sync');
      providerB.destroy();

      docA.getText('content').insert(0, 'Reconnect content');

      await waitFor(
        async () => {
          const res = await pool.query('SELECT ydoc FROM pages WHERE id = $1', [page.id]);
          return res.rows[0]?.ydoc !== null;
        },
        5_000,
        'post-disconnect persistence',
      );

      const docReconnected = new Y.Doc();
      const reconnectedProviderB = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: docReconnected,
        token: session.token,
      });

      await waitFor(() => reconnectedProviderB.synced, 5_000, 'reconnected provider sync');
      expect(docReconnected.getText('content').toString()).toBe('Reconnect content');

      providerA.destroy();
      reconnectedProviderB.destroy();
    });

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

    it('clears awareness state when a provider disconnects', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      const provider2 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      await waitFor(() => provider1.synced && provider2.synced, 5_000, 'providers to sync');
      provider1.setAwarenessField('user', { name: 'Disconnecting User' });

      await waitFor(
        () => {
          for (const state of provider2.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Disconnecting User') {
              return true;
            }
          }
          return false;
        },
        5_000,
        'awareness to propagate',
      );

      provider1.destroy();
      await sleep(500);

      const remainingStates = Array.from(provider2.awareness?.getStates().entries() ?? []);
      const staleStates = remainingStates.filter(
        ([, state]) => (state as { user?: { name?: string } }).user?.name === 'Disconnecting User',
      );
      expect(staleStates).toHaveLength(0);

      provider2.destroy();
    });

    it('restores awareness state after a provider reconnects', async () => {
      const user = await createTestUser(pool);
      const workspace = createTestWorkspace();
      await insertTestWorkspace(pool, workspace, user.id);
      const page = await createTestPage(pool, workspace.id, user.id);
      const session = await createTestSession(pool, user.id);

      const observerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      await waitFor(() => observerProvider.synced, 5_000, 'observer to sync');

      const provider1 = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      await waitFor(() => provider1.synced, 5_000, 'provider1 to sync');
      provider1.setAwarenessField('user', { name: 'Reconnect User' });

      await waitFor(
        () => {
          for (const state of observerProvider.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Reconnect User') {
              return true;
            }
          }
          return false;
        },
        5_000,
        'initial awareness to propagate',
      );

      provider1.destroy();
      await sleep(300);

      const reconnectedProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      await waitFor(() => reconnectedProvider.synced, 5_000, 'reconnected provider to sync');

      reconnectedProvider.setAwarenessField('user', { name: 'Reconnected Again' });

      await waitFor(
        () => {
          for (const state of observerProvider.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Reconnected Again') {
              return true;
            }
          }
          return false;
        },
        5_000,
        'reconnected awareness to propagate',
      );

      reconnectedProvider.destroy();
      observerProvider.destroy();
    });
  });
});
