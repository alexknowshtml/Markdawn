import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  type ConnectionConfiguration,
  Document,
  type onAuthenticatePayload,
  type onChangePayload,
  type onDisconnectPayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
  type Server,
} from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { revalidateActivePageConnections } from './permission-handler';
import {
  createCollabServer,
  publishFolderDeletion,
  publishPageDeletion,
  publishPageRename,
} from './server';
import {
  createCorruptedYjsDoc,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestYjsDoc,
  getTestPool,
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

function appendWikiLink(
  document: Y.Doc,
  { path, label, targetId }: { path: string; label: string; targetId?: string | undefined },
): void {
  const paragraph = new Y.XmlElement('paragraph');
  const link = new Y.XmlElement('wikiLink');
  link.setAttribute('path', path);
  link.setAttribute('label', label);
  if (targetId) link.setAttribute('targetId', targetId);
  paragraph.push([link]);
  document.getXmlFragment('prosemirror').push([paragraph]);
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
    server = createCollabServer({
      port: 0,
      pool,
      logger,
      debounceMs: 50,
      maxDebounceMs: 100,
      permissionRevalidationMs: 0,
    });
    await server.listen();
    port = (server as unknown as { address: { port: number } }).address.port;
  });

  afterAll(async () => {
    await server.destroy();
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

    it('allows anonymous access to pages public through an ancestor folder link', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      const token = crypto.randomUUID();
      await pool.query(
        `INSERT INTO folders (id, parent_id, name, position, created_by, is_public, public_token, created_at, updated_at)
         VALUES ($1, NULL, 'Public Folder', '0', $2, true, $3, NOW(), NOW())`,
        [folderId, owner.id, token],
      );
      const page = await createTestPage(pool, owner.id, 'Folder Public Page');
      await pool.query('UPDATE pages SET parent_id = $1, is_public = false WHERE id = $2', [
        folderId,
        page.id,
      ]);
      await pool.query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('folder', $1, $2, 'view', $3)`,
        [folderId, owner.id, token],
      );

      const connectionConfig = createConnectionConfig();
      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
        token: 'anon:folder-link-user',
        connectionConfig,
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as {
        user: { id: string; isAnonymous: boolean };
        permission: 'view' | 'edit' | 'admin';
      };
      expect(authenticated.user.id).toBe('folder-link-user');
      expect(authenticated.user.isAnonymous).toBe(true);
      expect(authenticated.permission).toBe('view');
      expect(connectionConfig.readOnly).toBe(true);
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
      const intruder = await createTestUser(pool);
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
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
      const ownerSession = await createTestSession(pool, owner.id);
      const intruderSession = await createTestSession(pool, intruder.id);
      const page = await createTestPage(pool, owner.id);

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

    it('logs access denial when user does not own the page', async () => {
      const intruder = await createTestUser(pool);
      const intruderSession = await createTestSession(pool, intruder.id);
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);

      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
        token: intruderSession.token,
      });

      await expect(server.hocuspocus.hooks('onAuthenticate', payload)).rejects.toThrow('Forbidden');
      expect(logger.debug).toHaveBeenCalledWith(
        `[auth] user=${intruder.id} denied access to page=${page.id} (invalid permission)`,
      );
    });
  });

  describe('onLoadDocument', () => {
    const ydocBytes = createTestYjsDoc('Hello from DB');
    const corruptedData = createCorruptedYjsDoc();

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const page = await createTestPage(pool, user.id, 'Test Page', ydocBytes);
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
      const page = await createTestPage(pool, user.id, 'Test Page', ydocBytes);
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
      expect(doc1.getText('content').toString()).toBe('Hello from DB');
      expect(doc2.getText('content').toString()).toBe('Hello from DB');

      provider1.destroy();
      provider2.destroy();
    });

    it('creates new document when stored ydoc is an empty buffer', async () => {
      const user = await createTestUser(pool);
      const pageId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO pages (id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
         VALUES ($1, NULL, 'Empty Buffer Page', '0', $2, NOW(), NOW(), $3)`,
        [pageId, user.id, Buffer.alloc(0)],
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
      const pageId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO pages (id, parent_id, title, position, created_by, created_at, updated_at, ydoc)
         VALUES ($1, NULL, 'Corrupted Page', '0', $2, NOW(), NOW(), $3)`,
        [pageId, user.id, Buffer.from(corruptedData)],
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
        permissionRevalidationMs: 0,
      });

      const user = await createTestUser(pool);
      const page = await createTestPage(pool, user.id);
      const documentName = page.id;
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: user.id }, permission: 'edit' },
        document: new Document(documentName),
        documentName,
        instance: failingServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await expect(failingServer.hocuspocus.hooks('onStoreDocument', payload)).rejects.toThrow(
        'forced db failure',
      );
      expect(failingLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`[persist] failed to save "${documentName}"`),
      );
    });

    it('does not persist anonymous edits after link access is revoked', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const token = crypto.randomUUID();
      await pool.query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'edit', $3)`,
        [page.id, owner.id, token],
      );
      await pool.query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);

      const document = new Document(page.id);
      document.getText('content').insert(0, 'Revoked anonymous edit');
      const connection = {
        context: { user: { id: 'anonymous-user', isAnonymous: true }, permission: 'edit' },
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = {
        getConnections: () => [connection],
      } as unknown as Document;
      server.hocuspocus.documents.set(page.id, activeDocument);
      await pool.query("DELETE FROM shares WHERE entity_type = 'page' AND entity_id = $1", [
        page.id,
      ]);
      await pool.query('UPDATE pages SET is_public = false, public_token = null WHERE id = $1', [
        page.id,
      ]);

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: 'anonymous-user', isAnonymous: true }, permission: 'edit' },
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await server.hocuspocus.hooks('onStoreDocument', payload);
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }

      const stored = await pool.query<{ ydoc: Buffer | null }>(
        'SELECT ydoc FROM pages WHERE id = $1',
        [page.id],
      );
      expect(stored.rows[0]?.ydoc).toBeNull();
      expect(connection.close).toHaveBeenCalledWith({ code: 4401, reason: 'Access revoked' });
    });

    it('rejects a debounced document containing an update from a revoked writer', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const token = crypto.randomUUID();
      await pool.query('UPDATE pages SET is_public = true, public_token = $1 WHERE id = $2', [
        token,
        page.id,
      ]);
      await pool.query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, permission, token)
         VALUES ('page', $1, $2, 'edit', $3)`,
        [page.id, owner.id, token],
      );
      const document = new Document(page.id);
      document.getText('content').insert(0, 'mixed update');
      const changeBase = {
        clientsCount: 2,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: null,
        update: new Uint8Array([1]),
      } satisfies Omit<onChangePayload, 'context'>;

      await server.hocuspocus.hooks('onChange', {
        ...changeBase,
        context: { user: { id: 'anonymous-writer', isAnonymous: true }, permission: 'edit' },
      });
      await server.hocuspocus.hooks('onChange', {
        ...changeBase,
        context: { user: { id: owner.id }, permission: 'edit' },
      });
      await pool.query("DELETE FROM shares WHERE entity_type = 'page' AND entity_id = $1", [
        page.id,
      ]);
      await pool.query('UPDATE pages SET is_public = false, public_token = null WHERE id = $1', [
        page.id,
      ]);

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'edit' },
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };
      await server.hocuspocus.hooks('onStoreDocument', payload);

      const stored = await pool.query<{ ydoc: Buffer | null }>(
        'SELECT ydoc FROM pages WHERE id = $1',
        [page.id],
      );
      expect(stored.rows[0]?.ydoc).toBeNull();
    });

    it('does not persist a wiki-link targetId from another workspace', async () => {
      const sourceOwner = await createTestUser(pool);
      const otherOwner = await createTestUser(pool);
      const source = await createTestPage(pool, sourceOwner.id, 'Source');
      const externalTarget = await createTestPage(pool, otherOwner.id, 'External Target');
      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'missing-in-source-workspace',
        label: 'External Target',
        targetId: externalTarget.id,
      });

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: sourceOwner.id }, permission: 'admin' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await server.hocuspocus.hooks('onStoreDocument', payload);

      const result = await pool.query<{ target_id: string | null }>(
        `SELECT target_id FROM connections
         WHERE source_id = $1 AND target_slug = 'missing-in-source-workspace'`,
        [source.id],
      );
      expect(result.rows[0]?.target_id).toBeNull();
    });

    it('does not restore a stale wiki-link targetId from another workspace', async () => {
      const sourceOwner = await createTestUser(pool);
      const otherOwner = await createTestUser(pool);
      const source = await createTestPage(pool, sourceOwner.id, 'Source');
      const externalTarget = await createTestPage(pool, otherOwner.id, 'External Target');
      await pool.query(
        `INSERT INTO connections (
           source_type, source_id, target_type, target_id, target_slug,
           target_label, connection_type, link_text, occurrence_count, updated_at
         ) VALUES ('page', $1, 'page', $2, 'renamed-target',
                   'External Target', 'wikilink', 'External Target', 1, NOW())`,
        [source.id, externalTarget.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, { path: 'renamed-target', label: 'External Target' });
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: sourceOwner.id }, permission: 'admin' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await server.hocuspocus.hooks('onStoreDocument', payload);

      const result = await pool.query<{ target_id: string | null }>(
        `SELECT target_id FROM connections
         WHERE source_id = $1 AND target_slug = 'renamed-target'`,
        [source.id],
      );
      expect(result.rows[0]?.target_id).toBeNull();
    });

    it('retains a valid wiki-link targetId from the source workspace', async () => {
      const owner = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Source');
      const target = await createTestPage(pool, owner.id, 'Roadmap');
      const document = new Document(source.id);
      appendWikiLink(document, { path: 'roadmap', label: 'Roadmap', targetId: target.id });

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'admin' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      await server.hocuspocus.hooks('onStoreDocument', payload);

      const result = await pool.query<{ target_id: string | null }>(
        `SELECT target_id FROM connections
         WHERE source_id = $1 AND target_slug = 'roadmap'`,
        [source.id],
      );
      expect(result.rows[0]?.target_id).toBe(target.id);
    });

    it('publishes metadata only through an active user meta room', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Original title');
      const metaRoomName = `page-meta:${owner.id}`;
      const metaDocument = new Document(metaRoomName);
      server.hocuspocus.documents.set(metaRoomName, metaDocument);

      try {
        const document = new Document(page.id);
        document.getText('title').insert(0, 'Updated title');
        const payload: onStoreDocumentPayload = {
          clientsCount: 1,
          context: { user: { id: owner.id }, permission: 'admin' },
          document,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        };

        await server.hocuspocus.hooks('onStoreDocument', payload);

        expect(metaDocument.getMap('pageIndex').get(page.id)).toEqual(
          expect.objectContaining({ title: 'Updated title' }),
        );
        expect(metaDocument.getMap('backlinksVersion').get(page.id)).toEqual(expect.any(Number));
      } finally {
        server.hocuspocus.documents.delete(metaRoomName);
      }
    });

    it('persists content edits to the database', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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

      // 5 edits within debounce window should produce far fewer connects than edits.
      // Each debounced onStoreDocument also verifies access before persisting.
      // Metadata fan-out is skipped here because no user meta room is active.
      expect(connectSpy.mock.calls.length).toBeGreaterThan(0);
      expect(connectSpy.mock.calls.length).toBeLessThanOrEqual(6);

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

  describe('active permission expiry', () => {
    it('disconnects a viewer after their only invitation expires', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission, expires_at
         ) values ('page', $1, $2, $3, 'view', now() - interval '1 second')`,
        [page.id, owner.id, viewer.id],
      );

      const connection = {
        context: { user: { id: viewer.id }, permission: 'view' },
        readOnly: true,
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = new Document(page.id);
      vi.spyOn(activeDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, activeDocument);

      try {
        await revalidateActivePageConnections(server, pool, logger);
        expect(connection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }
    });
  });

  describe('database event publication', () => {
    it('updates the active document even when rename metadata publication fails', async () => {
      const pageId = crypto.randomUUID();
      const activeDocument = new Document(pageId);
      const metaRoomId = crypto.randomUUID();
      activeDocument.getText('title').insert(0, 'Old title');
      server.hocuspocus.documents.set(pageId, activeDocument);
      server.hocuspocus.documents.set(
        `page-meta:${metaRoomId}`,
        new Document(`page-meta:${metaRoomId}`),
      );
      const failingPool = {
        query: vi.fn(async () => {
          throw new Error('metadata unavailable');
        }),
      } as unknown as typeof pool;

      try {
        await expect(
          publishPageRename(server.hocuspocus, failingPool, pageId, 'New title', logger),
        ).rejects.toThrow('Failed to publish rename metadata');
        expect(activeDocument.getText('title').toString()).toBe('New title');
      } finally {
        server.hocuspocus.documents.delete(pageId);
        server.hocuspocus.documents.delete(`page-meta:${metaRoomId}`);
      }
    });

    it('publishes descendant page deletions from one folder event', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO folders (id, name, position, created_by, created_at, updated_at)
         VALUES ($1, 'Deleted folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, owner.id);
      const deletedAt = new Date();
      await pool.query(
        'UPDATE pages SET parent_id = $1, is_deleted = true, deleted_at = $2 WHERE id = $3',
        [folderId, deletedAt, page.id],
      );
      await pool.query('UPDATE folders SET is_deleted = true, deleted_at = $1 WHERE id = $2', [
        deletedAt,
        folderId,
      ]);
      const connection = { sendStateless: vi.fn(), close: vi.fn() };
      const activeDocument = new Document(page.id);
      vi.spyOn(activeDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, activeDocument);

      try {
        await publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
        expect(connection.close).toHaveBeenCalledWith({ code: 4402, reason: 'Page deleted' });
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }
    });

    it('notifies active metadata rooms when an empty folder is deleted', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO folders (id, name, position, created_by, created_at, updated_at)
         VALUES ($1, 'Empty folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      await pool.query('UPDATE folders SET is_deleted = true, deleted_at = now() WHERE id = $1', [
        folderId,
      ]);

      const connection = { sendStateless: vi.fn(), close: vi.fn() };
      const metaDocument = new Document(`page-meta:${owner.id}`);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      try {
        await publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
        expect(connection.sendStateless).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'entity_deleted',
            entityType: 'folder',
            entityId: folderId,
          }),
        );
      } finally {
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('removes admin-created deleted pages from the workspace owner metadata', async () => {
      const owner = await createTestUser(pool);
      const admin = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO folders (id, name, position, created_by, created_at, updated_at)
         VALUES ($1, 'Owner folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, admin.id);
      await pool.query('UPDATE pages SET parent_id = $1 WHERE id = $2', [folderId, page.id]);
      const deletedAt = new Date();
      await pool.query('UPDATE pages SET is_deleted = true, deleted_at = $1 WHERE id = $2', [
        deletedAt,
        page.id,
      ]);
      await pool.query('UPDATE folders SET is_deleted = true, deleted_at = $1 WHERE id = $2', [
        deletedAt,
        folderId,
      ]);

      const metaDocument = new Document(`page-meta:${owner.id}`);
      metaDocument.getMap('pageIndex').set(page.id, { title: page.title });
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      try {
        await publishPageDeletion(server.hocuspocus, pool, page.id, logger);
        expect(metaDocument.getMap('pageIndex').has(page.id)).toBe(false);
      } finally {
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('closes active page connections before deleted-page metadata lookup', async () => {
      const pageId = crypto.randomUUID();
      const metaRoomId = crypto.randomUUID();
      const connection = {
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = new Document(pageId);
      vi.spyOn(activeDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(pageId, activeDocument);
      server.hocuspocus.documents.set(
        `page-meta:${metaRoomId}`,
        new Document(`page-meta:${metaRoomId}`),
      );
      const failingPool = {
        query: vi.fn(async () => {
          expect(connection.close).toHaveBeenCalledWith({ code: 4402, reason: 'Page deleted' });
          throw new Error('metadata unavailable');
        }),
      } as unknown as typeof pool;

      try {
        await expect(
          publishPageDeletion(server.hocuspocus, failingPool, pageId, logger),
        ).rejects.toThrow('metadata unavailable');
        expect(connection.sendStateless).toHaveBeenCalledWith(
          expect.stringContaining('"type":"entity_deleted"'),
        );
      } finally {
        server.hocuspocus.documents.delete(pageId);
        server.hocuspocus.documents.delete(`page-meta:${metaRoomId}`);
      }
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
        permissionRevalidationMs: 0,
      });

      const user = await createTestUser(pool);
      const page = await createTestPage(pool, user.id);
      const documentName = page.id;
      const doc = new Document(documentName);
      doc.getText('content').insert(0, 'pending');
      failingServer.hocuspocus.documents.set(documentName, doc);
      const payload: onDisconnectPayload = {
        clientsCount: 0,
        context: { user: { id: user.id } },
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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);

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
