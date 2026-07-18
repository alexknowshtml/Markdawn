import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  type beforeHandleMessagePayload,
  Connection,
  type ConnectionConfiguration,
  type connectedPayload,
  Document,
  type onAuthenticatePayload,
  type onChangePayload,
  type onDisconnectPayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
  type Server,
} from '@hocuspocus/server';
import {
  getAnimalEmoji,
  getAnonymousName,
  getStableColor,
  MAX_PAGE_TITLE_LENGTH,
} from '@markdawn/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { revalidateActivePageConnections } from './permission-handler';
import {
  createCollabServer,
  publishFolderDeletion,
  publishPageDeletion,
  publishPageRename,
  reconcileActiveCollaborationState,
  sanitizeCanonicalYjsUpdate,
  yjsUpdateIntroducesWikiLinkTargetIds,
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

async function waitForExactWorkspaceLockWaiter(
  pool: ReturnType<typeof getTestPool>,
  blockerPid: number,
  label: string,
): Promise<Date> {
  let transactionStartedAt: Date | undefined;
  await waitFor(
    async () => {
      const result = await pool.query<{ xact_start: Date | null }>(
        `select xact_start
         from pg_stat_activity
         where pg_blocking_pids(pid) = array[$1]::integer[]
           and wait_event_type = 'Lock'
           and query like '%pg_advisory_xact_lock%'
         order by xact_start
         limit 1`,
        [blockerPid],
      );
      transactionStartedAt = result.rows[0]?.xact_start ?? undefined;
      return transactionStartedAt !== undefined;
    },
    5_000,
    label,
  );
  if (!transactionStartedAt) throw new Error(`Missing transaction start for ${label}`);
  return transactionStartedAt;
}

async function waitUntilAfter(
  pool: ReturnType<typeof getTestPool>,
  expiresAt: Date,
): Promise<Date> {
  await pool.query(
    `select pg_sleep(
       greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp())) + 0.1)
     )`,
    [expiresAt],
  );
  const result = await pool.query<{ observed_at: Date }>('select clock_timestamp() as observed_at');
  const observedAt = result.rows[0]?.observed_at;
  if (!observedAt) throw new Error('Missing database clock after expiry wait');
  return observedAt;
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

function encodeVarUint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeVarString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes([encodeVarUint(bytes.length), bytes]);
}

function encodeProtocolMessage(
  documentName: string,
  messageType: number,
  payload?: string,
): Uint8Array {
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(messageType),
    ...(payload === undefined ? [] : [encodeVarString(payload)]),
  ]);
}

function encodeAuthenticationMessage(documentName: string, token: string): Uint8Array {
  // Hocuspocus MessageType.Auth = 2; AuthMessageType.Token = 0.
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(2),
    encodeVarUint(0),
    encodeVarString(token),
  ]);
}

function encodeAwarenessMessage(
  documentName: string,
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
): Uint8Array {
  const awarenessPayload = concatBytes([
    encodeVarUint(entries.length),
    ...entries.flatMap((entry) => [
      encodeVarUint(entry.clientId),
      encodeVarUint(entry.clock),
      encodeVarString(JSON.stringify(entry.state)),
    ]),
  ]);
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(1),
    encodeVarUint(awarenessPayload.length),
    awarenessPayload,
  ]);
}

function canonicalTestAwarenessUser(userId: string) {
  return {
    name: 'Test User',
    color: getStableColor(userId),
    avatar: null,
  };
}

function decodeProtocolMessageType(message: Uint8Array): number {
  const documentNameLength = readEncodedVarUint(message, 0);
  return readEncodedVarUint(message, documentNameLength.offset + documentNameLength.value).value;
}

function readEncodedVarUint(
  input: Uint8Array,
  initialOffset: number,
): { value: number; offset: number } {
  let value = 0;
  let multiplier = 1;
  let offset = initialOffset;
  while (offset < input.length) {
    const byte = input[offset];
    if (byte === undefined) break;
    value += (byte & 0x7f) * multiplier;
    offset += 1;
    if (byte < 0x80) return { value, offset };
    multiplier *= 128;
  }
  throw new Error('Malformed test protocol message');
}

function encodeYjsUpdateMessage(
  documentName: string,
  update: Uint8Array,
  { messageType = 0, syncType = 2 }: { messageType?: 0 | 4; syncType?: 0 | 1 | 2 } = {},
): Uint8Array {
  const name = new TextEncoder().encode(documentName);
  const chunks = [
    encodeVarUint(name.length),
    name,
    Uint8Array.of(messageType),
    Uint8Array.of(syncType),
    encodeVarUint(update.length),
    update,
  ];
  return concatBytes(chunks);
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

type PausedConnectionHarness = {
  connection: Connection;
  context: Record<string, unknown>;
  document: Document;
  hookResolved: Promise<void>;
  admissionsResolved(): number;
  releaseApply(): void;
  teardown: Promise<void>;
};

async function createPausedConnectionHarness(
  server: Server,
  pageId: string,
  sessionToken: string,
): Promise<PausedConnectionHarness> {
  const connectionConfig = createConnectionConfig();
  const context = (await server.hocuspocus.hooks(
    'onAuthenticate',
    createAuthenticatePayload(server, {
      documentName: pageId,
      token: sessionToken,
      connectionConfig,
    }),
  )) as Record<string, unknown>;
  const document = new Document(pageId);
  const socketId = crypto.randomUUID();
  const payloadBase = {
    context,
    document,
    documentName: pageId,
    instance: server.hocuspocus,
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    socketId,
  };
  await server.hocuspocus.hooks('onLoadDocument', {
    ...payloadBase,
    connectionConfig,
  });
  server.hocuspocus.documents.set(pageId, document);

  const fakeSocket = {
    binaryType: 'nodebuffer',
    readyState: WebSocket.OPEN,
    send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.()),
  } as unknown as WebSocket;
  const connection = new Connection(
    fakeSocket,
    { headers: {} } as onAuthenticatePayload['request'],
    document,
    socketId,
    context,
    connectionConfig.readOnly,
  );
  const pendingChanges: Promise<unknown>[] = [];
  document.onUpdate((changedDocument, origin, update) => {
    pendingChanges.push(
      server.hocuspocus.hooks('onChange', {
        ...payloadBase,
        clientsCount: changedDocument.getConnectionsCount(),
        document: changedDocument,
        transactionOrigin: origin,
        update,
      }),
    );
  });

  let resolveHook: (() => void) | undefined;
  let resolvedAdmissions = 0;
  const hookResolved = new Promise<void>((resolve) => {
    resolveHook = resolve;
  });
  let releaseApply: (() => void) | undefined;
  const applicationRelease = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  connection.beforeHandleMessage(async (activeConnection, update) => {
    await server.hocuspocus.hooks('beforeHandleMessage', {
      ...payloadBase,
      clientsCount: document.getConnectionsCount(),
      connection: activeConnection,
      update,
    });
    resolvedAdmissions += 1;
    resolveHook?.();
    await applicationRelease;
  });

  let resolveTeardown: (() => void) | undefined;
  let rejectTeardown: ((error: unknown) => void) | undefined;
  const teardown = new Promise<void>((resolve, reject) => {
    resolveTeardown = resolve;
    rejectTeardown = reject;
  });
  connection.onClose(() => {
    void (async () => {
      try {
        await Promise.all(pendingChanges);
        await server.hocuspocus.hooks('onDisconnect', {
          ...payloadBase,
          clientsCount: document.getConnectionsCount(),
        } satisfies onDisconnectPayload);
        await server.hocuspocus.hooks('beforeUnloadDocument', {
          instance: server.hocuspocus,
          documentName: pageId,
          document,
        });
        server.hocuspocus.documents.delete(pageId);
        document.destroy();
        await server.hocuspocus.hooks('afterUnloadDocument', {
          instance: server.hocuspocus,
          documentName: pageId,
        });
        resolveTeardown?.();
      } catch (error) {
        rejectTeardown?.(error);
      }
    })();
  });

  await server.hocuspocus.hooks('connected', {
    ...payloadBase,
    connection,
    connectionConfig,
    request: { headers: {} } as connectedPayload['request'],
  });

  return {
    connection,
    context,
    document,
    hookResolved,
    admissionsResolved: () => resolvedAdmissions,
    releaseApply: () => releaseApply?.(),
    teardown,
  };
}

describe('canonical wiki-link target metadata', () => {
  const hiddenTargetId = '11111111-1111-1111-1111-111111111111';

  it('rejects an out-of-order targetId attribute update before its parent can integrate', () => {
    const attacker = new Y.Doc();
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('path', 'Private roadmap');
    attacker.getXmlFragment('prosemirror').push([link]);
    const creationUpdate = Y.encodeStateAsUpdate(attacker);
    const afterCreation = Y.encodeStateVector(attacker);

    link.setAttribute('targetId', hiddenTargetId);
    const attributeOnlyUpdate = Y.encodeStateAsUpdate(attacker, afterCreation);
    expect(Buffer.from(attributeOnlyUpdate).includes(Buffer.from(hiddenTargetId))).toBe(true);

    const canonical = new Y.Doc();
    expect(yjsUpdateIntroducesWikiLinkTargetIds(canonical, attributeOnlyUpdate)).toBe(true);
    expect(
      Buffer.from(Y.encodeStateAsUpdate(canonical)).includes(Buffer.from(hiddenTargetId)),
    ).toBe(false);

    // A later valid parent update cannot complete the rejected attribute.
    Y.applyUpdate(canonical, creationUpdate);
    const canonicalLink = canonical.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    expect(canonicalLink.getAttribute('targetId')).toBeUndefined();
    expect(
      Buffer.from(Y.encodeStateAsUpdate(canonical)).includes(Buffer.from(hiddenTargetId)),
    ).toBe(false);
  });

  it('rejects a targetId attribute in an alternate XML root', () => {
    const attacker = new Y.Doc();
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('path', 'Private roadmap');
    link.setAttribute('targetId', hiddenTargetId);
    attacker.getXmlFragment('alternate').push([link]);

    expect(yjsUpdateIntroducesWikiLinkTargetIds(new Y.Doc(), Y.encodeStateAsUpdate(attacker))).toBe(
      true,
    );
  });

  it('re-encodes tombstoned targetId updates without retaining UUID bytes', () => {
    const source = new Y.Doc();
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('path', 'Private roadmap');
    source.getXmlFragment('prosemirror').push([link]);
    const creation = Y.encodeStateAsUpdate(source);
    const beforeSet = Y.encodeStateVector(source);
    link.setAttribute('targetId', hiddenTargetId);
    const setAttribute = Y.encodeStateAsUpdate(source, beforeSet);
    const beforeDelete = Y.encodeStateVector(source);
    link.removeAttribute('targetId');
    const deleteAttribute = Y.encodeStateAsUpdate(source, beforeDelete);
    const legacyState = Y.mergeUpdates([creation, setAttribute, deleteAttribute]);

    expect(Buffer.from(legacyState).includes(Buffer.from(hiddenTargetId))).toBe(true);
    const canonicalState = sanitizeCanonicalYjsUpdate(legacyState);
    expect(Buffer.from(canonicalState).includes(Buffer.from(hiddenTargetId))).toBe(false);

    const cleanClient = new Y.Doc();
    Y.applyUpdate(cleanClient, canonicalState);
    expect(
      yjsUpdateIntroducesWikiLinkTargetIds(new Y.Doc(), Y.encodeStateAsUpdate(cleanClient)),
    ).toBe(false);
  });
});

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
      const page = await createTestPage(pool, user.id);

      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      await waitFor(() => provider.synced, 5_000, 'provider to sync');
      expect(provider.isAuthenticated).toBe(true);
      provider.destroy();
    });

    it('makes user metadata rooms read only to clients', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const connectionConfig = createConnectionConfig();
      const payload = createAuthenticatePayload(server, {
        token: session.token,
        documentName: `page-meta:${user.id}`,
        connectionConfig,
      });

      await server.hocuspocus.hooks('onAuthenticate', payload);

      expect(connectionConfig.readOnly).toBe(true);
    });

    it('closes connections that exceed the configured WebSocket payload limit', async () => {
      const limitedServer = createCollabServer({
        port: 0,
        pool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
        maxPayloadBytes: 1024,
      });
      await limitedServer.listen();
      const limitedPort = (limitedServer as unknown as { address: { port: number } }).address.port;

      try {
        const closeCode = await new Promise<number>((resolve, reject) => {
          const socket = new WebSocket(`ws://localhost:${limitedPort}`);
          const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error('Timed out waiting for oversized payload rejection'));
          }, 5000);
          socket.on('open', () => socket.send(Buffer.alloc(1025)));
          socket.on('close', (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
          socket.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        expect(closeCode).toBe(1009);
      } finally {
        await limitedServer.destroy();
      }
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
      const page = await createTestPage(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
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
      const page = await createTestPage(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
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
      const page = await createTestPage(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
        requestHeaders: {
          cookie: `__Secure-better-auth.session_token=${session.token}`,
        },
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as { user: { id: string } };
      expect(authenticated.user.id).toBe(user.id);
    });

    it('allows anonymous access to pages public through an ancestor folder', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (
           id, parent_id, name, position, created_by, public_permission, created_at, updated_at
         ) values ($1, null, 'Public Folder', '0', $2, 'view', now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, owner.id, 'Folder Public Page');
      await pool.query('update pages set parent_id = $1 where id = $2', [folderId, page.id]);

      const anonymousId = crypto.randomUUID();
      const connectionConfig = createConnectionConfig();
      const payload = createAuthenticatePayload(server, {
        documentName: page.id,
        token: `anon:${anonymousId}`,
        connectionConfig,
      });

      const result = await server.hocuspocus.hooks('onAuthenticate', payload);
      const authenticated = result as {
        user: { id: string; isAnonymous: boolean };
        permission: 'view' | 'edit' | 'admin';
      };
      expect(authenticated.user.id).toBe(anonymousId);
      expect(authenticated.user.isAnonymous).toBe(true);
      expect(authenticated.permission).toBe('view');
      expect(connectionConfig.readOnly).toBe(true);
    });

    it('rejects malformed anonymous identities before querying page access', async () => {
      const querySpy = vi.spyOn(pool, 'query');
      const payload = createAuthenticatePayload(server, {
        documentName: crypto.randomUUID(),
        token: 'anon:not-a-uuid\nforged-log-line',
      });

      await expect(server.hocuspocus.hooks('onAuthenticate', payload)).rejects.toThrow('Forbidden');
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('rejects legacy anonymous identities with a share-token suffix before querying access', async () => {
      const querySpy = vi.spyOn(pool, 'query');
      const payload = createAuthenticatePayload(server, {
        documentName: crypto.randomUUID(),
        token: `anon:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      });

      await expect(server.hocuspocus.hooks('onAuthenticate', payload)).rejects.toThrow('Forbidden');
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('rejects an empty collaboration room name', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      const payload = createAuthenticatePayload(server, {
        documentName: '',
        token: session.token,
      });

      await expect(server.hocuspocus.hooks('onAuthenticate', payload)).rejects.toThrow('Forbidden');
    });

    it('rejects arbitrary and nonexistent collaboration rooms', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);

      await expect(
        server.hocuspocus.hooks(
          'onAuthenticate',
          createAuthenticatePayload(server, {
            documentName: 'attacker-controlled-room',
            token: session.token,
          }),
        ),
      ).rejects.toThrow('Forbidden');
      await expect(
        server.hocuspocus.hooks(
          'onAuthenticate',
          createAuthenticatePayload(server, {
            documentName: crypto.randomUUID(),
            token: session.token,
          }),
        ),
      ).rejects.toThrow('Forbidden');
    });

    it('emits an authoritative revisioned permission snapshot on every connection', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const context = (await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: session.token }),
      )) as {
        permission: 'view' | 'edit' | 'admin';
        accessRevision: string;
      };
      const connection = {
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as connectedPayload['connection'];

      await server.hocuspocus.hooks('connected', {
        context,
        documentName: page.id,
        instance: server.hocuspocus,
        request: {} as connectedPayload['request'],
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
        connection,
      });

      expect(context.accessRevision).toMatch(/^\d+$/);
      expect(connection.sendStateless).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_snapshot',
          permission: context.permission,
          accessRevision: context.accessRevision,
        }),
      );
    });

    it('orders delayed permission delivery by durable access revision', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );
      const blocker = await pool.connect();
      const delayedReader = await pool.connect();
      const mutationClient = await pool.connect();
      let mutationCommitted = false;
      const barrierKey = BigInt(
        `0x${crypto.randomUUID().replaceAll('-', '').slice(0, 15)}`,
      ).toString();

      try {
        await blocker.query('select pg_advisory_lock($1::bigint)', [barrierKey]);
        await mutationClient.query('begin');
        await mutationClient.query(
          `insert into workspace_access_versions (workspace_owner_id, version)
           values ($1, nextval('workspace_access_revision_seq'))
           on conflict (workspace_owner_id) do update
           set version = nextval('workspace_access_revision_seq')`,
          [owner.id],
        );
        await mutationClient.query(
          `update shares set permission = 'view'
           where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
          [page.id, editor.id],
        );
        const delayedResultPromise = delayedReader.query<{
          permission: string | null;
          access_revision: string;
        }>(
          `with barrier as materialized (
             select pg_advisory_lock($3::bigint)
           ), permission_snapshot as materialized (
             select get_page_access_revision($1)::text as access_revision
             from barrier
           )
           select access.permission, permission_snapshot.access_revision
           from permission_snapshot
           left join lateral get_effective_page_permission($1, $2) access on true`,
          [page.id, editor.id, barrierKey],
        );
        const delayedReaderPid = (delayedReader as unknown as { processID: number }).processID;
        await waitFor(
          async () => {
            const waiting = await pool.query<{ waiting: boolean }>(
              `select exists (
                 select 1 from pg_locks
                 where pid = $1 and locktype = 'advisory' and granted = false
               ) as waiting`,
              [delayedReaderPid],
            );
            return waiting.rows[0]?.waiting === true;
          },
          5_000,
          'pre-revoke permission query to reach the advisory barrier',
        );

        await mutationClient.query('commit');
        mutationCommitted = true;
        const currentResult = await pool.query<{
          permission: string | null;
          access_revision: string;
        }>(
          `select access.permission,
                  get_page_access_revision($1)::text as access_revision
           from get_effective_page_permission($1, $2) access`,
          [page.id, editor.id],
        );

        await blocker.query('select pg_advisory_unlock($1::bigint)', [barrierKey]);
        const delayedResult = await delayedResultPromise;
        await delayedReader.query('select pg_advisory_unlock($1::bigint)', [barrierKey]);

        expect(delayedResult.rows[0]?.permission).toBe('edit');
        expect(currentResult.rows[0]?.permission).toBe('view');
        expect(BigInt(delayedResult.rows[0]?.access_revision ?? '0')).toBeLessThan(
          BigInt(currentResult.rows[0]?.access_revision ?? '0'),
        );
      } finally {
        if (!mutationCommitted) await mutationClient.query('rollback').catch(() => undefined);
        await blocker.query('select pg_advisory_unlock($1::bigint)', [barrierKey]);
        await delayedReader.query('select pg_advisory_unlock($1::bigint)', [barrierKey]);
        blocker.release();
        delayedReader.release();
        mutationClient.release();
      }
    });

    it('quarantines all outbound document traffic until the post-auth access check succeeds', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const editorSession = await createTestSession(pool, editor.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );

      let editorAccessChecks = 0;
      let releaseConnectedCheck: (() => void) | undefined;
      let markConnectedCheckReached: (() => void) | undefined;
      const connectedCheckReached = new Promise<void>((resolve) => {
        markConnectedCheckReached = resolve;
      });
      const connectedCheckRelease = new Promise<void>((resolve) => {
        releaseConnectedCheck = resolve;
      });
      const gatedPool = new Proxy(pool, {
        get(target, property) {
          if (property === 'query') {
            return async (text: string, values?: unknown[]) => {
              const result = await target.query(text, values);
              if (
                text.includes('get_effective_page_permission') &&
                values?.[1] === editor.id &&
                ++editorAccessChecks === 2
              ) {
                markConnectedCheckReached?.();
                await connectedCheckRelease;
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const gatedServer = createCollabServer({
        port: 0,
        pool: gatedPool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
      });
      await gatedServer.listen();
      const gatedPort = (gatedServer as unknown as { address: { port: number } }).address.port;
      const ownerDocument = new Y.Doc();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${gatedPort}`,
        name: page.id,
        document: ownerDocument,
        token: ownerSession.token,
      });
      let racedSocket: WebSocket | undefined;

      try {
        await waitFor(() => ownerProvider.synced, 5_000, 'owner provider to establish the room');

        const receivedTypes: number[] = [];
        let resolveProtocolClose: (() => void) | undefined;
        const protocolClose = new Promise<void>((resolve) => {
          resolveProtocolClose = resolve;
        });
        racedSocket = new WebSocket(`ws://localhost:${gatedPort}`);
        racedSocket.on('message', (data) => {
          const bytes = Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const messageType = decodeProtocolMessageType(bytes);
          receivedTypes.push(messageType);
          if (messageType === 7) resolveProtocolClose?.();
        });
        await new Promise<void>((resolve, reject) => {
          racedSocket?.once('open', resolve);
          racedSocket?.once('error', reject);
        });
        racedSocket.send(encodeAuthenticationMessage(page.id, editorSession.token));
        racedSocket.send(
          encodeYjsUpdateMessage(page.id, Y.encodeStateVector(new Y.Doc()), { syncType: 0 }),
        );

        await Promise.race([
          connectedCheckReached,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for the post-auth connected check');
          }),
        ]);

        await pool.query(
          `delete from shares
           where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
          [page.id, editor.id],
        );

        ownerDocument.getText('content').insert(0, 'must never reach revoked socket');
        const activeDocument = gatedServer.hocuspocus.documents.get(page.id) as
          | Document
          | undefined;
        expect(activeDocument).toBeDefined();
        await waitFor(
          () => activeDocument?.getText('content').toString() === 'must never reach revoked socket',
          5_000,
          'established editor update to reach the server document',
        );
        activeDocument?.awareness.setLocalState({
          user: canonicalTestAwarenessUser(owner.id),
        });
        activeDocument?.broadcastStateless('must never reach revoked socket');
        await sleep(50);

        expect(receivedTypes.filter((type) => [0, 1, 3, 4, 5, 6, 8].includes(type))).toEqual([]);

        const provisionalConnection = activeDocument?.getConnections().find((connection) => {
          const context = connection.context as { user?: { id?: string } } | undefined;
          return context?.user?.id === editor.id;
        });
        expect(provisionalConnection).toBeDefined();
        provisionalConnection?.close({ code: 4401, reason: 'Access revoked' });
        await Promise.race([
          protocolClose,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for raced connection close');
          }),
        ]);

        releaseConnectedCheck?.();
        await sleep(50);
        expect(receivedTypes.filter((type) => [0, 1, 3, 4, 5, 6, 8].includes(type))).toEqual([]);
        expect(receivedTypes).toContain(2);
        expect(receivedTypes.at(-1)).toBe(7);
        activeDocument?.awareness.setLocalState(null);
      } finally {
        releaseConnectedCheck?.();
        racedSocket?.terminate();
        ownerProvider.destroy();
        await gatedServer.destroy();
      }
    });

    it('authenticates via WebSocket handshake with cookie header', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
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
        name: page.id,
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
    it('rejects a raw client broadcast-stateless frame before any peer receives it', async () => {
      const owner = await createTestUser(pool);
      const attacker = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, attacker.id],
      );
      const ownerSession = await createTestSession(pool, owner.id);
      const attackerSession = await createTestSession(pool, attacker.id);
      const peerStateless = vi.fn();
      const attackerClosed = vi.fn();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: ownerSession.token,
        onStateless: peerStateless,
      });
      const attackerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: attackerSession.token,
        onClose: attackerClosed,
      });

      try {
        await waitFor(
          () => ownerProvider.synced && attackerProvider.synced,
          5_000,
          'stateless adversarial providers to sync',
        );
        peerStateless.mockClear();
        attackerProvider.configuration.websocketProvider.webSocket?.send(
          encodeProtocolMessage(
            page.id,
            6,
            JSON.stringify({
              type: 'permission_snapshot',
              permission: 'admin',
              accessRevision: '999999999999999999',
            }),
          ),
        );

        await waitFor(
          () => attackerClosed.mock.calls.length > 0,
          5_000,
          'forged stateless sender to close',
        );
        await sleep(50);
        expect(peerStateless).not.toHaveBeenCalled();
      } finally {
        attackerProvider.destroy();
        ownerProvider.destroy();
      }
    });

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

  describe('write authorization fencing', () => {
    it('rejects a write when an account grant is revoked behind the workspace lock', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const editorSession = await createTestSession(pool, editor.id);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values (
           'page', $1, $2, $3, 'edit'
         )`,
        [page.id, owner.id, editor.id],
      );

      const context = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, {
          documentName: page.id,
          token: editorSession.token,
        }),
      );
      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      const connection = {
        context,
        readOnly: false,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const source = new Y.Doc();
      source.getText('content').insert(0, 'must expire behind the lock');
      const update = encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(source));
      const document = new Document(page.id);
      let lockReleased = false;

      try {
        await blocker.query('select pg_advisory_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        const admission = server.hocuspocus
          .hooks('beforeHandleMessage', {
            clientsCount: 1,
            context,
            document,
            documentName: page.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update,
            connection,
          })
          .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          );

        await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'write admission to wait on the workspace lock',
        );
        await blocker.query(
          `delete from shares
           where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
          [page.id, editor.id],
        );
        await blocker.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        lockReleased = true;

        const outcome = await admission;
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toBe('Forbidden');
        }
        expect(connection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
        expect(document.getText('content').toString()).toBe('');
      } finally {
        if (!lockReleased) {
          await blocker
            .query('select pg_advisory_unlock(hashtextextended($1, 0))', [
              `workspace-access:${owner.id}`,
            ])
            .catch(() => undefined);
        }
        blocker.release();
      }
    });

    it('rejects a write when the workspace lock wait crosses session expiry', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const context = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, {
          documentName: page.id,
          token: session.token,
        }),
      );
      const expiry = await pool.query<{ expires_at: Date }>(
        `update sessions
         set expires_at = clock_timestamp() + interval '3 seconds'
         where token = $1
         returning expires_at`,
        [session.token],
      );
      const expiresAt = expiry.rows[0]?.expires_at;
      if (!expiresAt) throw new Error('Expected expiring session');
      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      const connection = {
        context,
        readOnly: false,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const source = new Y.Doc();
      source.getText('content').insert(0, 'must not outlive the session');
      const update = encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(source));
      const document = new Document(page.id);
      let lockReleased = false;

      try {
        await blocker.query('select pg_advisory_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        const admission = server.hocuspocus
          .hooks('beforeHandleMessage', {
            clientsCount: 1,
            context,
            document,
            documentName: page.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update,
            connection,
          })
          .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          );

        const transactionStartedAt = await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'session-expiry write admission to wait on the exact workspace lock',
        );
        expect(transactionStartedAt.getTime()).toBeLessThan(expiresAt.getTime());
        expect(expiresAt.getTime() - transactionStartedAt.getTime()).toBeGreaterThan(1_000);
        const observedAfterExpiry = await waitUntilAfter(pool, expiresAt);
        expect(observedAfterExpiry.getTime()).toBeGreaterThan(expiresAt.getTime());
        await blocker.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        lockReleased = true;

        const outcome = await admission;
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toBe('Forbidden');
        }
        expect(connection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
        expect(document.getText('content').toString()).toBe('');
      } finally {
        if (!lockReleased) {
          await blocker
            .query('select pg_advisory_unlock(hashtextextended($1, 0))', [
              `workspace-access:${owner.id}`,
            ])
            .catch(() => undefined);
        }
        blocker.release();
      }
    });

    it('rejects an anonymous write when public access is revoked behind the workspace lock', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query("update pages set public_permission = 'edit' where id = $1", [page.id]);
      const anonymousId = crypto.randomUUID();
      const context = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, {
          documentName: page.id,
          token: `anon:${anonymousId}`,
        }),
      );
      expect((context as { permission?: unknown }).permission).toBe('edit');
      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      const connection = {
        context,
        readOnly: false,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const source = new Y.Doc();
      source.getText('content').insert(0, 'must not outlive public access');
      const update = encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(source));
      const document = new Document(page.id);
      let lockReleased = false;

      try {
        await blocker.query('select pg_advisory_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        const admission = server.hocuspocus
          .hooks('beforeHandleMessage', {
            clientsCount: 1,
            context,
            document,
            documentName: page.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update,
            connection,
          })
          .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          );

        await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'public-access write admission to wait on the exact workspace lock',
        );
        await blocker.query('update pages set public_permission = null where id = $1', [page.id]);
        await blocker.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);
        lockReleased = true;

        const outcome = await admission;
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toBe('Forbidden');
        }
        expect(connection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
        expect(document.getText('content').toString()).toBe('');
      } finally {
        if (!lockReleased) {
          await blocker
            .query('select pg_advisory_unlock(hashtextextended($1, 0))', [
              `workspace-access:${owner.id}`,
            ])
            .catch(() => undefined);
        }
        blocker.release();
      }
    });

    it('rejects a real view-only provider update without leaking it to an owner', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const viewerSession = await createTestSession(pool, viewer.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const viewerDocument = new Y.Doc();
      const viewerClosed = vi.fn();
      const viewerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: viewerDocument,
        token: viewerSession.token,
        onClose: viewerClosed,
      });

      try {
        await waitFor(() => viewerProvider.synced, 5_000, 'viewer provider to sync');
        viewerDocument.getText('content').insert(0, 'view-only update');
        await waitFor(
          () => viewerClosed.mock.calls.length > 0,
          5_000,
          'view-only writer to disconnect',
        );
      } finally {
        viewerProvider.destroy();
      }

      const ownerDocument = new Y.Doc();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: ownerDocument,
        token: ownerSession.token,
      });
      try {
        await waitFor(() => ownerProvider.synced, 5_000, 'owner provider to sync');
        expect(ownerDocument.getText('content').toString()).toBe('');
        const persisted = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        expect(persisted.rows[0]?.ydoc).toBeNull();
      } finally {
        ownerProvider.destroy();
      }
    });

    it('rejects every viewer write envelope while allowing the same bytes from an owner', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const viewerSession = await createTestSession(pool, viewer.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const viewerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: viewerSession.token }),
      );
      const ownerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: ownerSession.token }),
      );
      const document = new Document(page.id);
      const viewerConnection = {
        context: viewerContext,
        readOnly: true,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const ownerConnection = {
        context: ownerContext,
        readOnly: false,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      for (const messageType of [0, 4] as const) {
        for (const syncType of [1, 2] as const) {
          const rejectedDocument = new Y.Doc();
          rejectedDocument
            .getText('content')
            .insert(0, `rejected envelope ${messageType}:${syncType}`);
          const rejectedUpdate = Y.encodeStateAsUpdate(rejectedDocument);
          const basePayload = {
            clientsCount: 2,
            document,
            documentName: page.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update: encodeYjsUpdateMessage(page.id, rejectedUpdate, { messageType, syncType }),
          };

          await expect(
            server.hocuspocus.hooks('beforeHandleMessage', {
              ...basePayload,
              context: viewerContext,
              connection: viewerConnection,
            }),
          ).rejects.toThrow('Write permission required');
          await expect(
            server.hocuspocus.hooks('beforeHandleMessage', {
              ...basePayload,
              context: ownerContext,
              connection: ownerConnection,
            }),
          ).resolves.toBeUndefined();
          Y.applyUpdate(document, rejectedUpdate);
        }
      }

      expect(document.getText('content').toString()).toContain('rejected envelope');
      expect(viewerConnection.close).toHaveBeenCalledWith({
        code: 4403,
        reason: 'Write permission required',
      });
      expect(ownerConnection.close).not.toHaveBeenCalled();
    });

    it('does not let a rejected viewer envelope poison an already-active owner replica', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const viewerSession = await createTestSession(pool, viewer.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const replicaServer = createCollabServer({
        port: 0,
        pool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
      });
      const replicaContext = await replicaServer.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(replicaServer, {
          documentName: page.id,
          token: ownerSession.token,
        }),
      );
      const replicaDocument = new Document(page.id);
      await replicaServer.hocuspocus.hooks('onLoadDocument', {
        context: replicaContext,
        document: replicaDocument,
        documentName: page.id,
        instance: replicaServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      const viewerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: viewerSession.token }),
      );
      const rejectedDocument = new Y.Doc();
      rejectedDocument.getText('content').insert(0, 'cross-replica rejected update');
      const rejectedUpdate = Y.encodeStateAsUpdate(rejectedDocument);
      const updateMessage = encodeYjsUpdateMessage(page.id, rejectedUpdate);
      const viewerConnection = {
        context: viewerContext,
        readOnly: true,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const replicaConnection = {
        context: replicaContext,
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];

      try {
        await expect(
          server.hocuspocus.hooks('beforeHandleMessage', {
            clientsCount: 1,
            context: viewerContext,
            document: new Document(page.id),
            documentName: page.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update: updateMessage,
            connection: viewerConnection,
          }),
        ).rejects.toThrow('Write permission required');
        await expect(
          replicaServer.hocuspocus.hooks('beforeHandleMessage', {
            clientsCount: 1,
            context: replicaContext,
            document: replicaDocument,
            documentName: page.id,
            instance: replicaServer.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            update: updateMessage,
            connection: replicaConnection,
          }),
        ).resolves.toBeUndefined();
        expect(replicaConnection.close).not.toHaveBeenCalled();
      } finally {
        await replicaServer.destroy();
      }
    });

    it('keeps the page owner-loadable and editable after a 1026-client viewer envelope', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const viewerSession = await createTestSession(pool, viewer.id);
      const ownerSession = await createTestSession(pool, owner.id);
      const viewerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: viewerSession.token }),
      );
      const combinedViewerDocument = new Y.Doc();
      for (let index = 0; index < 1026; index++) {
        const clientDocument = new Y.Doc();
        clientDocument.getMap(`client-${index}`).set('value', index);
        Y.applyUpdate(combinedViewerDocument, Y.encodeStateAsUpdate(clientDocument));
      }
      const rejectedUpdate = Y.encodeStateAsUpdate(combinedViewerDocument);
      const viewerConnection = {
        context: viewerContext,
        readOnly: true,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];

      await expect(
        server.hocuspocus.hooks('beforeHandleMessage', {
          clientsCount: 1,
          context: viewerContext,
          document: new Document(page.id),
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
          update: encodeYjsUpdateMessage(page.id, rejectedUpdate),
          connection: viewerConnection,
        }),
      ).rejects.toThrow('Write permission required');
      expect(viewerConnection.close).toHaveBeenCalledWith({
        code: 4403,
        reason: 'Write permission required',
      });

      const ownerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: ownerSession.token }),
      );
      const ownerDocument = new Document(page.id);
      await expect(
        server.hocuspocus.hooks('onLoadDocument', {
          context: ownerContext,
          document: ownerDocument,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
          connectionConfig: createConnectionConfig(),
        }),
      ).resolves.toBeUndefined();
      const ownerEditDocument = new Y.Doc();
      ownerEditDocument.getText('content').insert(0, 'owner remains editable');
      const ownerUpdate = Y.encodeStateAsUpdate(ownerEditDocument);
      const ownerConnection = {
        context: ownerContext,
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      await expect(
        server.hocuspocus.hooks('beforeHandleMessage', {
          clientsCount: 1,
          context: ownerContext,
          document: ownerDocument,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
          update: encodeYjsUpdateMessage(page.id, ownerUpdate),
          connection: ownerConnection,
        }),
      ).resolves.toBeUndefined();
      Y.applyUpdate(ownerDocument, ownerUpdate);
      await server.hocuspocus.hooks('onChange', {
        clientsCount: 1,
        context: ownerContext,
        document: ownerDocument,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: ownerConnection,
        update: ownerUpdate,
      });
      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context: ownerContext,
        document: ownerDocument,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });
      const persisted = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      const persistedDocument = new Y.Doc();
      Y.applyUpdate(persistedDocument, new Uint8Array(persisted.rows[0]?.ydoc ?? []));
      expect(persistedDocument.getText('content').toString()).toBe('owner remains editable');
      expect(persistedDocument.share.has('client-0')).toBe(false);
      expect(persistedDocument.share.has('client-1025')).toBe(false);
      expect(ownerConnection.close).not.toHaveBeenCalled();
    });

    it('closes only malformed viewer writers and preserves an owner pending edit', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const ownerSession = await createTestSession(pool, owner.id);
      const viewerSession = await createTestSession(pool, viewer.id);
      const ownerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: ownerSession.token }),
      );
      const viewerContext = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: viewerSession.token }),
      );
      const document = new Document(page.id);
      await server.hocuspocus.hooks('onLoadDocument', {
        context: ownerContext,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      server.hocuspocus.documents.set(page.id, document);
      const ownerConnection = {
        context: ownerContext,
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const ownerClientDocument = new Y.Doc();
      ownerClientDocument.getText('content').insert(0, 'owner pending edit');
      const ownerUpdate = Y.encodeStateAsUpdate(ownerClientDocument);
      const payloadBase = {
        clientsCount: 2,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await server.hocuspocus.hooks('beforeHandleMessage', {
          ...payloadBase,
          context: ownerContext,
          update: encodeYjsUpdateMessage(page.id, ownerUpdate),
          connection: ownerConnection,
        });
        Y.applyUpdate(document, ownerUpdate);
        await server.hocuspocus.hooks('onChange', {
          ...payloadBase,
          context: ownerContext,
          transactionOrigin: ownerConnection,
          update: ownerUpdate,
        });

        for (const syncType of [1, 2] as const) {
          const viewerConnection = {
            context: viewerContext,
            readOnly: true,
            sendStateless: vi.fn(),
            close: vi.fn(),
          } as unknown as beforeHandleMessagePayload['connection'];
          await expect(
            server.hocuspocus.hooks('beforeHandleMessage', {
              ...payloadBase,
              context: viewerContext,
              update: encodeYjsUpdateMessage(page.id, Uint8Array.of(0xff), { syncType }),
              connection: viewerConnection,
            }),
          ).rejects.toThrow('Write permission required');
          expect(viewerConnection.close).toHaveBeenCalledWith({
            code: 4403,
            reason: 'Write permission required',
          });
        }

        expect(ownerConnection.close).not.toHaveBeenCalled();
        expect(document.getText('content').toString()).toBe('owner pending edit');
        await server.hocuspocus.hooks('onStoreDocument', {
          ...payloadBase,
          context: ownerContext,
        });
        const persisted = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        const persistedDocument = new Y.Doc();
        Y.applyUpdate(persistedDocument, new Uint8Array(persisted.rows[0]?.ydoc ?? []));
        expect(persistedDocument.getText('content').toString()).toBe('owner pending edit');
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }
    });

    it('persists an edit admitted before a downgrade without evicting the room', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );
      const session = await createTestSession(pool, editor.id);
      const context = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: session.token }),
      );
      const document = new Document(page.id);
      await server.hocuspocus.hooks('onLoadDocument', {
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'authorized before downgrade');
      const update = Y.encodeStateAsUpdate(clientDocument);
      const connection = {
        context,
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];

      await server.hocuspocus.hooks('beforeHandleMessage', {
        clientsCount: 2,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        update: encodeYjsUpdateMessage(page.id, update),
        connection,
      });
      Y.applyUpdate(document, update);
      await server.hocuspocus.hooks('onChange', {
        clientsCount: 2,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: connection,
        update,
      });
      await pool.query(
        `update shares set permission = 'view'
         where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
        [page.id, editor.id],
      );

      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 2,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const stored = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
      expect(storedDocument.getText('content').toString()).toBe('authorized before downgrade');
      expect(connection.close).not.toHaveBeenCalled();
    });

    it('preserves an admitted edit when Trash commits before Yjs applies it', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const context = await server.hocuspocus.hooks(
        'onAuthenticate',
        createAuthenticatePayload(server, { documentName: page.id, token: session.token }),
      );
      const document = new Document(page.id);
      await server.hocuspocus.hooks('onLoadDocument', {
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'linearized before Trash');
      const update = Y.encodeStateAsUpdate(clientDocument);
      const connection = {
        context,
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      } as unknown as beforeHandleMessagePayload['connection'];
      const payloadBase = {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      // The permission fence is the linearization point. Trash commits after
      // it, but before Hocuspocus applies the admitted Yjs message.
      await server.hocuspocus.hooks('beforeHandleMessage', {
        ...payloadBase,
        update: encodeYjsUpdateMessage(page.id, update),
        connection,
      });
      await pool.query(
        `update pages
         set is_deleted = true, deleted_at = now(), updated_at = now()
         where id = $1`,
        [page.id],
      );
      Y.applyUpdate(document, update);
      await server.hocuspocus.hooks('onChange', {
        ...payloadBase,
        transactionOrigin: connection,
        update,
      });
      await server.hocuspocus.hooks('onStoreDocument', payloadBase);

      const trashed = await pool.query<{ is_deleted: boolean; ydoc: Buffer | null }>(
        'select is_deleted, ydoc from pages where id = $1',
        [page.id],
      );
      expect(trashed.rows[0]?.is_deleted).toBe(true);
      const trashedDocument = new Y.Doc();
      Y.applyUpdate(trashedDocument, new Uint8Array(trashed.rows[0]?.ydoc ?? []));
      expect(trashedDocument.getText('content').toString()).toBe('linearized before Trash');

      await pool.query(
        `update pages
         set is_deleted = false, deleted_at = null, updated_at = now()
         where id = $1`,
        [page.id],
      );
      const restoredDocument = new Document(page.id);
      await server.hocuspocus.hooks('onLoadDocument', {
        ...payloadBase,
        document: restoredDocument,
        connectionConfig: createConnectionConfig(),
      });
      expect(restoredDocument.getText('content').toString()).toBe('linearized before Trash');
      expect(connection.close).not.toHaveBeenCalled();
    });
  });

  describe('held write application fences', () => {
    it('persists an exact admitted update when revoke closes the real connection before apply', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );
      const session = await createTestSession(pool, editor.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'admitted before revoke teardown');
      const update = Y.encodeStateAsUpdate(clientDocument);

      harness.connection.handleMessage(encodeYjsUpdateMessage(page.id, update));
      await Promise.race([
        harness.hookResolved,
        sleep(5_000).then(() => {
          throw new Error('Timed out waiting for held write admission');
        }),
      ]);

      await pool.query(
        `delete from shares
         where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
        [page.id, editor.id],
      );
      await revalidateActivePageConnections(server, pool, logger);
      expect(harness.context.permission).toBeNull();
      expect(harness.document.hasConnection(harness.connection)).toBe(true);
      expect(harness.document.isDestroyed).toBe(false);

      harness.releaseApply();
      await Promise.race([
        harness.teardown,
        sleep(5_000).then(() => {
          throw new Error('Timed out waiting for deferred revoke teardown');
        }),
      ]);

      expect(harness.document.isDestroyed).toBe(true);
      expect(server.hocuspocus.documents.has(page.id)).toBe(false);
      const stored = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
      expect(storedDocument.getText('content').toString()).toBe('admitted before revoke teardown');
    });

    it('keeps Trash blocked through physical apply and persists before real close/unload', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'applied before Trash teardown');
      const update = Y.encodeStateAsUpdate(clientDocument);
      const trashClient = await pool.connect();
      let trashCommitted = false;

      try {
        harness.connection.handleMessage(encodeYjsUpdateMessage(page.id, update));
        await Promise.race([
          harness.hookResolved,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for held write admission');
          }),
        ]);

        const trashPromise = trashClient
          .query(
            `update pages
             set is_deleted = true, deleted_at = now(), updated_at = now()
             where id = $1`,
            [page.id],
          )
          .then(() => {
            trashCommitted = true;
          });
        const trashPid = (trashClient as unknown as { processID: number }).processID;
        await waitFor(
          async () => {
            const result = await pool.query<{ waiting: boolean }>(
              `select exists (
                 select 1 from pg_stat_activity
                 where pid = $1 and wait_event_type = 'Lock'
               ) as waiting`,
              [trashPid],
            );
            return result.rows[0]?.waiting === true;
          },
          5_000,
          'Trash update to wait behind the application fence',
        );
        expect(trashCommitted).toBe(false);

        harness.releaseApply();
        await trashPromise;
        expect(harness.document.getText('content').toString()).toBe(
          'applied before Trash teardown',
        );
        await publishPageDeletion(server.hocuspocus, pool, page.id, logger);
        await Promise.race([
          harness.teardown,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for Trash teardown');
          }),
        ]);

        expect(harness.document.isDestroyed).toBe(true);
        expect(server.hocuspocus.documents.has(page.id)).toBe(false);
        const stored = await pool.query<{ is_deleted: boolean; ydoc: Buffer | null }>(
          'select is_deleted, ydoc from pages where id = $1',
          [page.id],
        );
        expect(stored.rows[0]?.is_deleted).toBe(true);
        const storedDocument = new Y.Doc();
        Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(storedDocument.getText('content').toString()).toBe('applied before Trash teardown');
      } finally {
        harness.releaseApply();
        trashClient.release();
      }
    });

    it('linearizes an API rename queued after admission after the physical title apply', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Initial title');
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      const clientDocument = new Y.Doc();
      clientDocument.getText('title').insert(0, 'Collaborative title');
      const titleUpdate = Y.encodeStateAsUpdate(clientDocument);
      const apiClient = await pool.connect();
      let apiRenameCommitted = false;

      try {
        harness.connection.handleMessage(encodeYjsUpdateMessage(page.id, titleUpdate));
        await Promise.race([
          harness.hookResolved,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for held title admission');
          }),
        ]);
        const apiRename = apiClient
          .query(
            `update pages
             set title = 'API title after admission',
                 title_revision = title_revision + 1,
                 updated_at = now()
             where id = $1`,
            [page.id],
          )
          .then(() => {
            apiRenameCommitted = true;
          });
        const apiPid = (apiClient as unknown as { processID: number }).processID;
        await waitFor(
          async () => {
            const result = await pool.query<{ waiting: boolean }>(
              `select exists (
                 select 1 from pg_stat_activity
                 where pid = $1 and wait_event_type = 'Lock'
               ) as waiting`,
              [apiPid],
            );
            return result.rows[0]?.waiting === true;
          },
          5_000,
          'API rename to wait behind the title application fence',
        );
        expect(apiRenameCommitted).toBe(false);

        harness.releaseApply();
        await apiRename;
        await reconcileActiveCollaborationState(server, pool, logger);
        expect(harness.document.getText('title').toString()).toBe('API title after admission');

        await server.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 1,
          context: harness.context,
          document: harness.document,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
        const stored = await pool.query<{
          title: string;
          title_revision: string;
          ydoc: Buffer | null;
        }>('select title, title_revision::text as title_revision, ydoc from pages where id = $1', [
          page.id,
        ]);
        expect(stored.rows[0]?.title).toBe('API title after admission');
        expect(BigInt(stored.rows[0]?.title_revision ?? '0')).toBeGreaterThanOrEqual(1n);
        const storedDocument = new Y.Doc();
        Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(storedDocument.getText('title').toString()).toBe('API title after admission');

        harness.connection.close();
        await harness.teardown;
      } finally {
        harness.releaseApply();
        apiClient.release();
      }
    });

    it('lets a collaborative title admitted after an API rename win before delayed listener delivery', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Initial title');
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      await pool.query(
        `update pages
         set title = 'API title first', title_revision = title_revision + 1, updated_at = now()
         where id = $1`,
        [page.id],
      );
      const clientDocument = new Y.Doc();
      clientDocument.getText('title').insert(0, 'Collaborative title after API');

      try {
        harness.connection.handleMessage(
          encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(clientDocument)),
        );
        await harness.hookResolved;
        harness.releaseApply();
        await waitFor(
          () => harness.document.getText('title').toString() === 'Collaborative title after API',
          5_000,
          'collaborative title to physically apply',
        );

        // Store before the delayed page_renamed listener. The admission's
        // title-only revision proves this collaboration write is later.
        await server.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 1,
          context: harness.context,
          document: harness.document,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
        await reconcileActiveCollaborationState(server, pool, logger);

        const stored = await pool.query<{ title: string; title_revision: string }>(
          'select title, title_revision::text as title_revision from pages where id = $1',
          [page.id],
        );
        expect(stored.rows[0]?.title).toBe('Collaborative title after API');
        expect(BigInt(stored.rows[0]?.title_revision ?? '0')).toBe(2n);
        expect(harness.document.getText('title').toString()).toBe('Collaborative title after API');

        harness.connection.close();
        await harness.teardown;
      } finally {
        harness.releaseApply();
      }
    });

    it('does not let a content-only admission mask an earlier API rename', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Initial title');
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      await pool.query(
        `update pages
         set title = 'API title before content', title_revision = title_revision + 1,
             updated_at = now()
         where id = $1`,
        [page.id],
      );
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'content-only change');

      try {
        harness.connection.handleMessage(
          encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(clientDocument)),
        );
        await harness.hookResolved;
        harness.releaseApply();
        await waitFor(
          () => harness.document.getText('content').toString() === 'content-only change',
          5_000,
          'content-only update to physically apply',
        );
        await server.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 1,
          context: harness.context,
          document: harness.document,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });

        const stored = await pool.query<{
          title: string;
          title_revision: string;
          ydoc: Buffer | null;
        }>('select title, title_revision::text as title_revision, ydoc from pages where id = $1', [
          page.id,
        ]);
        expect(stored.rows[0]?.title).toBe('API title before content');
        expect(BigInt(stored.rows[0]?.title_revision ?? '0')).toBe(1n);
        const storedDocument = new Y.Doc();
        Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(storedDocument.getText('title').toString()).toBe('API title before content');
        expect(storedDocument.getText('content').toString()).toBe('content-only change');

        harness.connection.close();
        await harness.teardown;
      } finally {
        harness.releaseApply();
      }
    });

    it('finalizes a duplicate no-op update that emits no onChange event', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'one effective update');
      const updateMessage = encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(clientDocument));

      try {
        harness.connection.handleMessage(updateMessage);
        await harness.hookResolved;
        harness.releaseApply();
        await waitFor(
          () => harness.document.getText('content').toString() === 'one effective update',
          5_000,
          'first update to apply',
        );
        await waitFor(
          () => harness.context.applicationsInFlight === undefined,
          5_000,
          'first application transaction to finalize',
        );

        harness.connection.handleMessage(updateMessage);
        await waitFor(
          () => harness.admissionsResolved() >= 2,
          5_000,
          'duplicate update permission hook to resolve',
        );
        await waitFor(
          () => harness.context.applicationsInFlight === undefined,
          5_000,
          'duplicate no-op transaction to finalize',
        );
        await Promise.race([
          pool.query(
            `update pages
             set title = 'lock released after duplicate', title_revision = title_revision + 1
             where id = $1`,
            [page.id],
          ),
          sleep(2_000).then(() => {
            throw new Error('Duplicate update leaked its application lock');
          }),
        ]);

        harness.connection.close();
        await harness.teardown;
        const stored = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        const storedDocument = new Y.Doc();
        Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(storedDocument.getText('content').toString()).toBe('one effective update');
      } finally {
        harness.releaseApply();
      }
    });

    it('finalizes and releases the held transaction when malformed Yjs emits no onChange', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(server, page.id, session.token);

      harness.connection.handleMessage(
        encodeYjsUpdateMessage(page.id, Uint8Array.of(0xff, 0xfe, 0xfd)),
      );
      await harness.hookResolved;
      harness.releaseApply();
      await waitFor(
        () => harness.context.applicationsInFlight === undefined,
        5_000,
        'malformed application transaction to finalize',
      );

      await Promise.race([
        pool.query(
          `update pages
           set title = 'lock released after malformed', title_revision = title_revision + 1
           where id = $1`,
          [page.id],
        ),
        sleep(2_000).then(() => {
          throw new Error('Malformed update leaked its application lock');
        }),
      ]);
      expect(harness.document.getText('content').toString()).toBe('');
      harness.connection.close();
      await harness.teardown;
      const stored = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      expect(stored.rows[0]?.ydoc).toBeNull();
      expect(harness.document.isDestroyed).toBe(true);
    });

    it('rolls back a timed-out application fence and rejects the late physical apply', async () => {
      const timeoutServer = createCollabServer({
        port: 0,
        pool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
        applicationFenceTimeoutMs: 50,
      });
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const session = await createTestSession(pool, owner.id);
      const harness = await createPausedConnectionHarness(timeoutServer, page.id, session.token);
      const clientDocument = new Y.Doc();
      clientDocument.getText('content').insert(0, 'must not apply after timeout');

      try {
        harness.connection.handleMessage(
          encodeYjsUpdateMessage(page.id, Y.encodeStateAsUpdate(clientDocument)),
        );
        await harness.hookResolved;
        await Promise.race([
          harness.teardown,
          sleep(5_000).then(() => {
            throw new Error('Timed-out application fence did not close and unload');
          }),
        ]);
        await Promise.race([
          pool.query(
            `update pages
             set title = 'lock released after timeout', title_revision = title_revision + 1
             where id = $1`,
            [page.id],
          ),
          sleep(2_000).then(() => {
            throw new Error('Timed-out application fence leaked its database lock');
          }),
        ]);

        harness.releaseApply();
        await sleep(50);
        expect(harness.document.getText('content').toString()).toBe('');
        const stored = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        expect(stored.rows[0]?.ydoc).toBeNull();
      } finally {
        harness.releaseApply();
        await timeoutServer.destroy();
      }
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

    it('rebuilds an authenticated user metadata room from PostgreSQL', async () => {
      const user = await createTestUser(pool);
      const page = await createTestPage(pool, user.id, 'Metadata page');
      const documentName = `page-meta:${user.id}`;
      const document = new Document(documentName);
      const payload: onLoadDocumentPayload = {
        context: { user: { id: user.id } },
        document,
        documentName,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      await server.hocuspocus.hooks('onLoadDocument', payload);

      expect(document.getMap('pageIndex').get(page.id)).toEqual(
        expect.objectContaining({ title: 'Metadata page' }),
      );
    });

    it('redacts hidden parent ids in rebuilt and incremental page metadata', async () => {
      const owner = await createTestUser(pool);
      const recipient = await createTestUser(pool);
      const parentId = crypto.randomUUID();
      await pool.query(
        `insert into folders (
           id, name, position, created_by, public_permission, created_at, updated_at
         ) values ($1, 'Hidden Public Parent', '0', $2, 'view', now(), now())`,
        [parentId, owner.id],
      );
      const page = await createTestPage(pool, owner.id, 'Directly Shared Child');
      await pool.query('update pages set parent_id = $1 where id = $2', [parentId, page.id]);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, recipient.id],
      );

      const metaRoomName = `page-meta:${recipient.id}`;
      const metaDocument = new Document(metaRoomName);
      await server.hocuspocus.hooks('onLoadDocument', {
        context: { user: { id: recipient.id } },
        document: metaDocument,
        documentName: metaRoomName,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      expect(metaDocument.getMap('pageIndex').get(page.id)).toEqual(
        expect.objectContaining({ parentId: null }),
      );

      server.hocuspocus.documents.set(metaRoomName, metaDocument);
      const pageDocument = new Document(page.id);
      pageDocument.getText('content').insert(0, 'owner update');
      const storePayload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'edit' },
        document: pageDocument,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };
      try {
        await server.hocuspocus.hooks('onStoreDocument', storePayload);
        expect(metaDocument.getMap('pageIndex').get(page.id)).toEqual(
          expect.objectContaining({ parentId: null }),
        );

        await pool.query(
          `insert into folder_public_access_visits (
             folder_id, user_id, first_seen_at, last_seen_at
           ) values ($1, $2, now(), now())`,
          [parentId, recipient.id],
        );
        await server.hocuspocus.hooks('onStoreDocument', storePayload);
        expect(metaDocument.getMap('pageIndex').get(page.id)).toEqual(
          expect.objectContaining({ parentId }),
        );
      } finally {
        server.hocuspocus.documents.delete(metaRoomName);
      }
    });

    it('excludes stale public visits after access is revoked', async () => {
      const owner = await createTestUser(pool);
      const recipient = await createTestUser(pool);
      const livePage = await createTestPage(pool, owner.id, 'Live direct share');
      const revokedPage = await createTestPage(pool, owner.id, 'Revoked public page');
      const stalePage = await createTestPage(pool, owner.id, 'Stale public visit');
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [livePage.id, owner.id, recipient.id],
      );
      await pool.query(
        `insert into page_public_access_visits (page_id, user_id)
         values ($1, $3), ($2, $3)`,
        [revokedPage.id, stalePage.id, recipient.id],
      );

      const documentName = `page-meta:${recipient.id}`;
      const document = new Document(documentName);
      const payload: onLoadDocumentPayload = {
        context: { user: { id: recipient.id } },
        document,
        documentName,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };

      await server.hocuspocus.hooks('onLoadDocument', payload);
      expect(document.getMap('pageIndex').has(livePage.id)).toBe(true);
      expect(document.getMap('pageIndex').has(revokedPage.id)).toBe(false);
      expect(document.getMap('pageIndex').has(stalePage.id)).toBe(false);

      server.hocuspocus.documents.set(documentName, document);
      try {
        await publishPageRename(server.hocuspocus, pool, revokedPage.id, 'Revoked renamed', logger);
        await publishPageRename(server.hocuspocus, pool, stalePage.id, 'Stale renamed', logger);
        expect(document.getMap('pageIndex').has(revokedPage.id)).toBe(false);
        expect(document.getMap('pageIndex').has(stalePage.id)).toBe(false);
      } finally {
        server.hocuspocus.documents.delete(documentName);
      }
    });

    it('periodically invalidates dashboard metadata after revocation and edit-to-view fallback', async () => {
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const periodicServer = createCollabServer({
        port: 0,
        pool,
        logger: mockLogger(),
        permissionRevalidationMs: 1_000,
      });
      const owner = await createTestUser(pool);
      const recipient = await createTestUser(pool);
      const directPage = await createTestPage(pool, owner.id, 'Revoked direct grant');
      const publicPage = await createTestPage(pool, owner.id, 'Revoked public access');
      const fallbackPage = await createTestPage(pool, owner.id, 'Edit falling back to view');
      const folderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (id, name, position, created_by, created_at, updated_at)
         values ($1, 'Shared folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      await pool.query('update pages set parent_id = $1 where id = $2', [
        folderId,
        fallbackPage.id,
      ]);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')`,
        [directPage.id, owner.id, recipient.id],
      );
      await pool.query("update pages set public_permission = 'view' where id = $1", [
        publicPage.id,
      ]);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values
           ('folder', $1, $3, $4, 'view'),
           ('page', $2, $3, $4, 'edit')`,
        [folderId, fallbackPage.id, owner.id, recipient.id],
      );
      await pool.query(
        `insert into page_public_access_visits (page_id, user_id)
         values ($1, $2)`,
        [publicPage.id, recipient.id],
      );

      const documentName = `page-meta:${recipient.id}`;
      const document = new Document(documentName);
      try {
        await periodicServer.hocuspocus.hooks('onLoadDocument', {
          context: { user: { id: recipient.id } },
          document,
          documentName,
          instance: periodicServer.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
          connectionConfig: createConnectionConfig(),
        });
        periodicServer.hocuspocus.documents.set(documentName, document);
        expect(document.getMap('pageIndex').has(directPage.id)).toBe(true);
        expect(document.getMap('pageIndex').has(publicPage.id)).toBe(true);
        expect(document.getMap('pageIndex').has(fallbackPage.id)).toBe(true);
        expect(document.getMap('accessPermissions').get(fallbackPage.id)).toBe('edit');

        const reconciled = new Promise<void>((resolve) => {
          const versions = document.getMap<number>('accessVersion');
          const observer = () => {
            versions.unobserve(observer);
            resolve();
          };
          versions.observe(observer);
        });
        await pool.query(
          `delete from shares
           where entity_type = 'page' and entity_id = any($1::uuid[])`,
          [[directPage.id, fallbackPage.id]],
        );
        await pool.query('update pages set public_permission = null where id = $1', [
          publicPage.id,
        ]);
        await vi.advanceTimersByTimeAsync(1_000);
        let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reconciled,
            new Promise<never>((_resolve, reject) => {
              reconciliationTimeout = realSetTimeout(
                () => reject(new Error('Timed out waiting for metadata reconciliation')),
                5_000,
              );
            }),
          ]);
        } finally {
          if (reconciliationTimeout) realClearTimeout(reconciliationTimeout);
        }

        expect(document.getMap('pageIndex').has(directPage.id)).toBe(false);
        expect(document.getMap('pageIndex').has(publicPage.id)).toBe(false);
        expect(document.getMap('pageIndex').has(fallbackPage.id)).toBe(true);
        expect(document.getMap('accessPermissions').get(fallbackPage.id)).toBe('view');
        expect(document.getMap<number>('accessVersion').get('access')).toBe(1);
      } finally {
        periodicServer.hocuspocus.documents.delete(documentName);
        await periodicServer.destroy();
        vi.useRealTimers();
      }
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

    it('strips and rewrites legacy wiki-link target IDs before initial sync', async () => {
      const hiddenTargetId = '44444444-4444-4444-4444-444444444444';
      const user = await createTestUser(pool);
      const legacyDocument = new Y.Doc();
      const link = new Y.XmlElement('wikiLink');
      link.setAttribute('targetId', hiddenTargetId);
      link.setAttribute('path', 'Private roadmap');
      legacyDocument.getXmlFragment('prosemirror').push([link]);
      const legacyState = Y.encodeStateAsUpdate(legacyDocument);
      expect(Buffer.from(legacyState).includes(Buffer.from(hiddenTargetId))).toBe(true);
      const page = await createTestPage(pool, user.id, 'Source page', legacyState);

      const loadedDocument = new Document(page.id);
      await server.hocuspocus.hooks('onLoadDocument', {
        context: { user: { id: user.id } },
        document: loadedDocument,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });

      const loadedLink = loadedDocument.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      expect(loadedLink.getAttribute('targetId')).toBeUndefined();
      expect(
        Buffer.from(Y.encodeStateAsUpdate(loadedDocument)).includes(Buffer.from(hiddenTargetId)),
      ).toBe(false);
      const stored = await pool.query<{ ydoc: Buffer }>('select ydoc from pages where id = $1', [
        page.id,
      ]);
      expect(stored.rows[0]?.ydoc.includes(Buffer.from(hiddenTargetId))).toBe(false);
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

    it('rejects when page does not exist in the database', async () => {
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

      await expect(server.hocuspocus.hooks('onLoadDocument', payload)).rejects.toThrow('Forbidden');
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

    it('disconnects and does not persist an oversized document', async () => {
      const sizeLogger = mockLogger();
      const sizeLimitedServer = createCollabServer({
        port: 0,
        pool,
        logger: sizeLogger,
        permissionRevalidationMs: 0,
        maxDocumentBytes: 256,
      });
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const before = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      const document = new Document(page.id);
      document.getText('content').insert(0, 'x'.repeat(2048));
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'admin' },
        document,
        documentName: page.id,
        instance: sizeLimitedServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await sizeLimitedServer.hocuspocus.hooks('onStoreDocument', payload);
        const after = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        expect(after.rows[0]?.ydoc).toEqual(before.rows[0]?.ydoc);
        expect(sizeLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`[size] blocked page=${page.id}`),
        );
      } finally {
        await sizeLimitedServer.destroy();
      }
    });

    it('broadcasts a canonical title update without disconnecting collaborators', async () => {
      const owner = await createTestUser(pool);
      const session = await createTestSession(pool, owner.id);
      const page = await createTestPage(pool, owner.id);
      const document = new Y.Doc();
      const onDisconnect = vi.fn();
      const provider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document,
        token: session.token,
        onDisconnect,
      });

      try {
        await waitFor(() => provider.synced, 5_000, 'provider to sync');
        const titleText = document.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, 'x'.repeat(MAX_PAGE_TITLE_LENGTH + 1));

        await waitFor(
          () => titleText.toString() === page.title,
          5_000,
          'canonical title compensation',
        );
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`[title] rejected page=${page.id}`),
        );
      } finally {
        provider.destroy();
      }
    });

    it('restores and persists the canonical title after an oversized collaborative update', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const document = new Document(page.id);
      const connection = { close: vi.fn(), send: vi.fn() };
      vi.spyOn(document, 'getConnections').mockReturnValue([connection] as unknown as ReturnType<
        Document['getConnections']
      >);
      server.hocuspocus.documents.set(page.id, document);
      const context = { user: { id: owner.id }, permission: 'admin' };
      const loadPayload: onLoadDocumentPayload = {
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      };
      const storePayload: onStoreDocumentPayload = {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await server.hocuspocus.hooks('onLoadDocument', loadPayload);
        const titleText = document.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, 'x'.repeat(MAX_PAGE_TITLE_LENGTH + 1));
        await server.hocuspocus.hooks('onChange', {
          clientsCount: 1,
          context,
          document,
          documentName: page.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
          transactionOrigin: null,
          update: Y.encodeStateAsUpdate(document),
        });

        await server.hocuspocus.hooks('onStoreDocument', storePayload);

        const after = await pool.query<{ title: string; ydoc: Buffer | null }>(
          'select title, ydoc from pages where id = $1',
          [page.id],
        );
        const persistedDocument = new Y.Doc();
        Y.applyUpdate(persistedDocument, new Uint8Array(after.rows[0]?.ydoc ?? []));
        expect(document.getText('title').toString()).toBe(page.title);
        expect(after.rows[0]?.title).toBe(page.title);
        expect(persistedDocument.getText('title').toString()).toBe(page.title);
        expect(connection.close).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`[title] rejected page=${page.id}`),
        );
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }
    });

    it('counts astral Unicode titles by code point at the 250-character boundary', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const document = new Document(page.id);
      const connection = { close: vi.fn(), send: vi.fn() };
      vi.spyOn(document, 'getConnections').mockReturnValue([connection] as unknown as ReturnType<
        Document['getConnections']
      >);
      server.hocuspocus.documents.set(page.id, document);
      const context = { user: { id: owner.id }, permission: 'admin' as const };
      const payloadBase = {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await server.hocuspocus.hooks('onLoadDocument', {
          ...payloadBase,
          connectionConfig: createConnectionConfig(),
        });
        const titleText = document.getText('title');
        const acceptedTitle = '😀'.repeat(MAX_PAGE_TITLE_LENGTH);
        titleText.delete(0, titleText.length);
        titleText.insert(0, acceptedTitle);
        await server.hocuspocus.hooks('onChange', {
          ...payloadBase,
          transactionOrigin: connection,
          update: Y.encodeStateAsUpdate(document),
        });
        await server.hocuspocus.hooks('onStoreDocument', payloadBase);
        expect(document.getText('title').toString()).toBe(acceptedTitle);
        const accepted = await pool.query<{ title: string }>(
          'select title from pages where id = $1',
          [page.id],
        );
        expect(accepted.rows[0]?.title).toBe(acceptedTitle);

        titleText.delete(0, titleText.length);
        titleText.insert(0, `${acceptedTitle}😀`);
        await server.hocuspocus.hooks('onChange', {
          ...payloadBase,
          transactionOrigin: connection,
          update: Y.encodeStateAsUpdate(document),
        });
        await server.hocuspocus.hooks('onStoreDocument', payloadBase);
        expect(document.getText('title').toString()).toBe(acceptedTitle);
        const rejected = await pool.query<{ title: string }>(
          'select title from pages where id = $1',
          [page.id],
        );
        expect(rejected.rows[0]?.title).toBe(acceptedTitle);
        expect(connection.close).not.toHaveBeenCalled();
      } finally {
        server.hocuspocus.documents.delete(page.id);
      }
    });

    it('fails closed when persistence permission verification is unavailable', async () => {
      const verificationLogger = mockLogger();
      const verificationPool = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          if (text.includes('get_effective_page_permission')) {
            throw new Error('permission database unavailable');
          }
          return pool.query(text, values);
        }),
      } as unknown as typeof pool;
      const verificationServer = createCollabServer({
        port: 0,
        pool: verificationPool,
        logger: verificationLogger,
        permissionRevalidationMs: 0,
      });
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const document = new Document(page.id);
      document.getText('content').insert(0, 'Unverified edit');
      const connection = { close: vi.fn() };
      vi.spyOn(document, 'getConnections').mockReturnValue([connection] as unknown as ReturnType<
        Document['getConnections']
      >);
      verificationServer.hocuspocus.documents.set(page.id, document);
      const before = await pool.query<{ ydoc: Buffer | null }>(
        'select ydoc from pages where id = $1',
        [page.id],
      );
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'admin' },
        document,
        documentName: page.id,
        instance: verificationServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };
      await verificationServer.hocuspocus.hooks('onChange', {
        clientsCount: 1,
        context: payload.context,
        document,
        documentName: page.id,
        instance: verificationServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: null,
        update: Y.encodeStateAsUpdate(document),
      });

      try {
        await verificationServer.hocuspocus.hooks('onStoreDocument', payload);
        expect(connection.close).toHaveBeenCalledWith({
          code: 4500,
          reason: 'Permission verification failed',
        });
        const after = await pool.query<{ ydoc: Buffer | null }>(
          'select ydoc from pages where id = $1',
          [page.id],
        );
        expect(after.rows[0]?.ydoc).toEqual(before.rows[0]?.ydoc);
        expect(verificationLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('permission verification failed'),
        );
      } finally {
        verificationServer.hocuspocus.documents.delete(page.id);
        await verificationServer.destroy();
      }
    });

    it('rethrows unexpected persistence verification errors after failing closed', async () => {
      const unexpectedLogger = mockLogger();
      const unexpectedServer = createCollabServer({
        port: 0,
        pool,
        logger: unexpectedLogger,
        permissionRevalidationMs: 0,
      });
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const unexpectedError = new Error('forced connection update failure');
      const activeDocument = {
        getConnections: () => {
          throw unexpectedError;
        },
      } as unknown as Document;
      unexpectedServer.hocuspocus.documents.set(page.id, activeDocument);
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: owner.id }, permission: 'admin' },
        document: new Document(page.id),
        documentName: page.id,
        instance: unexpectedServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        await expect(unexpectedServer.hocuspocus.hooks('onStoreDocument', payload)).rejects.toThrow(
          'forced connection update failure',
        );
        expect(unexpectedLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('unexpected permission revalidation failure'),
        );
      } finally {
        unexpectedServer.hocuspocus.documents.delete(page.id);
        await unexpectedServer.destroy();
      }
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

    it('rechecks writer access under the workspace lock before persistence', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `INSERT INTO shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         VALUES ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, editor.id],
      );

      let resolveLockAttempt: (() => void) | undefined;
      const lockAttempted = new Promise<void>((resolve) => {
        resolveLockAttempt = resolve;
      });
      const persistencePool = {
        query: (text: string, values?: unknown[]) => pool.query(text, values),
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (text: string, values?: unknown[]) => {
              if (text.includes('pg_advisory_xact_lock')) resolveLockAttempt?.();
              return client.query(text, values);
            },
            release: () => client.release(),
          };
        },
      } as unknown as typeof pool;
      const lockedServer = createCollabServer({
        port: 0,
        pool: persistencePool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
      });
      const permissionMutation = await pool.connect();
      let mutationOpen = true;
      await permissionMutation.query('BEGIN');
      await permissionMutation.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `workspace-access:${owner.id}`,
      ]);

      const document = new Document(page.id);
      document.getText('content').insert(0, 'Stale editor update');
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: editor.id }, permission: 'edit' },
        document,
        documentName: page.id,
        instance: lockedServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };

      try {
        const storePromise = lockedServer.hocuspocus.hooks('onStoreDocument', payload);
        await lockAttempted;
        await permissionMutation.query(
          `DELETE FROM shares
           WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2`,
          [page.id, editor.id],
        );
        await permissionMutation.query('COMMIT');
        mutationOpen = false;
        await storePromise;

        const stored = await pool.query<{ ydoc: Buffer | null }>(
          'SELECT ydoc FROM pages WHERE id = $1',
          [page.id],
        );
        expect(stored.rows[0]?.ydoc).toBeNull();
      } finally {
        if (mutationOpen) await permissionMutation.query('ROLLBACK');
        permissionMutation.release();
        await lockedServer.destroy();
      }
    });

    it('does not persist anonymous edits after public access is revoked', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      const anonymousId = crypto.randomUUID();
      await pool.query("update pages set public_permission = 'edit' where id = $1", [page.id]);

      const document = new Document(page.id);
      document.getText('content').insert(0, 'Revoked anonymous edit');
      const connection = {
        context: {
          user: { id: anonymousId, isAnonymous: true },
          permission: 'edit',
        },
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = {
        getConnections: () => [connection],
      } as unknown as Document;
      server.hocuspocus.documents.set(page.id, activeDocument);
      await pool.query('update pages set public_permission = null where id = $1', [page.id]);

      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: {
          user: { id: anonymousId, isAnonymous: true },
          permission: 'edit',
        },
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
      const anonymousId = crypto.randomUUID();
      await pool.query("update pages set public_permission = 'edit' where id = $1", [page.id]);
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
        context: {
          user: { id: anonymousId, isAnonymous: true },
          permission: 'edit',
        },
      });
      await server.hocuspocus.hooks('onChange', {
        ...changeBase,
        context: { user: { id: owner.id }, permission: 'edit' },
      });
      const anonymousConnection = {
        context: {
          user: { id: anonymousId, isAnonymous: true },
          permission: 'edit',
        },
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const ownerConnection = {
        context: { user: { id: owner.id }, permission: 'edit' },
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = {
        getConnections: () => [anonymousConnection, ownerConnection],
      } as unknown as Document;
      server.hocuspocus.documents.set(page.id, activeDocument);
      await pool.query('update pages set public_permission = null where id = $1', [page.id]);

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
      expect(anonymousConnection.sendStateless).toHaveBeenCalledWith(
        expect.stringContaining('"action":"revoke"'),
      );
      expect(ownerConnection.sendStateless).not.toHaveBeenCalled();
      expect(ownerConnection.close).toHaveBeenCalledWith({
        code: 4500,
        reason: 'Document reload required',
      });
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

    it('does not resolve a same-workspace hidden targetId for a page editor', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Shared Source');
      const hiddenTarget = await createTestPage(pool, owner.id, 'Hidden Canonical Title');
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'edit')`,
        [source.id, owner.id, editor.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'authored-unresolved-path',
        label: 'Authored Alias',
        targetId: hiddenTarget.id,
      });
      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context: { user: { id: editor.id }, permission: 'edit' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const result = await pool.query<{
        target_id: string | null;
        target_label: string;
        link_text: string | null;
      }>(
        `select target_id, target_label, link_text
         from connections
         where source_id = $1 and target_slug = 'authored-unresolved-path'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({
        target_id: null,
        target_label: 'authored-unresolved-path',
        link_text: 'Authored Alias',
      });
      expect(result.rows[0]?.target_label).not.toBe(hiddenTarget.title);
    });

    it('does not resolve a same-workspace hidden title for a page editor', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Shared Source');
      await createTestPage(pool, owner.id, 'Hidden Slug Target');
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'edit')`,
        [source.id, owner.id, editor.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, { path: 'hidden slug target', label: 'Authored Alias' });
      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context: { user: { id: editor.id }, permission: 'edit' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const result = await pool.query<{
        target_id: string | null;
        target_label: string;
        link_text: string | null;
      }>(
        `select target_id, target_label, link_text
         from connections
         where source_id = $1 and target_slug = 'hidden slug target'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({
        target_id: null,
        target_label: 'hidden slug target',
        link_text: 'Authored Alias',
      });
    });

    it('uses the intersection of every writer in a debounced document batch', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Shared Source');
      const hiddenTarget = await createTestPage(pool, owner.id, 'Owner Only Target');
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'edit')`,
        [source.id, owner.id, editor.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'owner-only-target',
        label: 'Authored Alias',
        targetId: hiddenTarget.id,
      });
      const ownerContext = { user: { id: owner.id }, permission: 'edit' as const };
      const editorContext = { user: { id: editor.id }, permission: 'edit' as const };
      server.hocuspocus.documents.set(source.id, document);
      try {
        for (const [context, update] of [
          [ownerContext, new Uint8Array([1])],
          [editorContext, new Uint8Array([2])],
        ] as const) {
          await server.hocuspocus.hooks('onChange', {
            clientsCount: 2,
            context,
            document,
            documentName: source.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            transactionOrigin: null,
            update,
          });
        }

        await server.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 2,
          context: ownerContext,
          document,
          documentName: source.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
      } finally {
        server.hocuspocus.documents.delete(source.id);
      }

      const result = await pool.query<{ target_id: string | null; target_label: string }>(
        `select target_id, target_label from connections
         where source_id = $1 and target_slug = 'owner-only-target'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({
        target_id: null,
        target_label: 'owner-only-target',
      });
    });

    it('intersects authenticated and anonymous writers in one debounced batch', async () => {
      const owner = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Public Editable Source');
      const privateTarget = await createTestPage(pool, owner.id, 'Account Only Target');
      await pool.query("update pages set public_permission = 'edit' where id = $1", [source.id]);

      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'account-only-target',
        label: 'Authored Alias',
        targetId: privateTarget.id,
      });
      const ownerContext = { user: { id: owner.id }, permission: 'edit' as const };
      const anonymousContext = {
        user: { id: crypto.randomUUID(), isAnonymous: true },
        permission: 'edit' as const,
      };
      server.hocuspocus.documents.set(source.id, document);
      try {
        for (const [context, update] of [
          [ownerContext, new Uint8Array([1])],
          [anonymousContext, new Uint8Array([2])],
        ] as const) {
          await server.hocuspocus.hooks('onChange', {
            clientsCount: 2,
            context,
            document,
            documentName: source.id,
            instance: server.hocuspocus,
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            socketId: crypto.randomUUID(),
            transactionOrigin: null,
            update,
          });
        }
        await server.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 2,
          context: ownerContext,
          document,
          documentName: source.id,
          instance: server.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
      } finally {
        server.hocuspocus.documents.delete(source.id);
      }

      const result = await pool.query<{ target_id: string | null; target_label: string }>(
        `select target_id, target_label from connections
         where source_id = $1 and target_slug = 'account-only-target'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({
        target_id: null,
        target_label: 'account-only-target',
      });
    });

    it('does not resolve a private target for an anonymous public editor', async () => {
      const owner = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Public Editable Source');
      const hiddenTarget = await createTestPage(pool, owner.id, 'Private Target');
      await pool.query("update pages set public_permission = 'edit' where id = $1", [source.id]);

      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'private-target',
        label: 'Authored Alias',
        targetId: hiddenTarget.id,
      });
      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context: {
          user: { id: crypto.randomUUID(), isAnonymous: true },
          permission: 'edit',
        },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const result = await pool.query<{ target_id: string | null; target_label: string }>(
        `select target_id, target_label from connections
         where source_id = $1 and target_slug = 'private-target'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({ target_id: null, target_label: 'private-target' });
    });

    it('resolves a target that the page editor can enumerate', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Shared Source');
      const target = await createTestPage(pool, owner.id, 'Visible Target');
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values
           ('page', $1, $2, $3, 'edit'),
           ('page', $4, $2, $3, 'view')`,
        [source.id, owner.id, editor.id, target.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, { path: 'visible target', label: 'Authored Alias' });
      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context: { user: { id: editor.id }, permission: 'edit' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const result = await pool.query<{ target_id: string | null; target_label: string }>(
        `select target_id, target_label
         from connections
         where source_id = $1 and target_slug = 'visible target'`,
        [source.id],
      );
      expect(result.rows[0]).toEqual({ target_id: target.id, target_label: 'Visible Target' });
    });

    it('resolves explicit paths only through folder ancestry the editor can enumerate', async () => {
      const owner = await createTestUser(pool);
      const editor = await createTestUser(pool);
      const source = await createTestPage(pool, owner.id, 'Shared Source');
      const target = await createTestPage(pool, owner.id, 'Path Target');
      const privateFolderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (id, name, position, created_by, created_at, updated_at)
         values ($1, 'Private Folder', '0', $2, now(), now())`,
        [privateFolderId, owner.id],
      );
      await pool.query('update pages set parent_id = $1 where id = $2', [
        privateFolderId,
        target.id,
      ]);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values
           ('page', $1, $2, $3, 'edit'),
           ('page', $4, $2, $3, 'view')`,
        [source.id, owner.id, editor.id, target.id],
      );

      const document = new Document(source.id);
      appendWikiLink(document, {
        path: 'private folder/path target',
        label: 'Authored Alias',
      });
      const payload: onStoreDocumentPayload = {
        clientsCount: 1,
        context: { user: { id: editor.id }, permission: 'edit' },
        document,
        documentName: source.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      };
      await server.hocuspocus.hooks('onStoreDocument', payload);

      const hiddenResult = await pool.query<{ target_id: string | null }>(
        `select target_id from connections
         where source_id = $1 and target_slug = 'private folder/path target'`,
        [source.id],
      );
      expect(hiddenResult.rows[0]?.target_id).toBeNull();

      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('folder', $1, $2, $3, 'view')`,
        [privateFolderId, owner.id, editor.id],
      );
      await server.hocuspocus.hooks('onStoreDocument', payload);

      const visibleResult = await pool.query<{ target_id: string | null; target_label: string }>(
        `select target_id, target_label from connections
         where source_id = $1 and target_slug = 'private folder/path target'`,
        [source.id],
      );
      expect(visibleResult.rows[0]).toEqual({
        target_id: target.id,
        target_label: 'Path Target',
      });
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

    it('does not overwrite a newer API rename with a stale collaboration save', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Original title');
      const document = new Document(page.id);
      const context = { user: { id: owner.id }, permission: 'admin' as const };
      await server.hocuspocus.hooks('onLoadDocument', {
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      document.getText('content').insert(0, 'local edit');
      await pool.query(
        'update pages set title = $1, title_revision = title_revision + 1 where id = $2',
        ['API title', page.id],
      );

      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const stored = await pool.query<{ title: string; ydoc: Buffer | null }>(
        'select title, ydoc from pages where id = $1',
        [page.id],
      );
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
      expect(stored.rows[0]?.title).toBe('API title');
      expect(storedDocument.getText('title').toString()).toBe('API title');
      expect(storedDocument.getText('content').toString()).toBe('local edit');
    });

    it('merges a newer database Yjs snapshot under the persistence lock', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Merge page');
      const document = new Document(page.id);
      const context = { user: { id: owner.id }, permission: 'admin' as const };
      await server.hocuspocus.hooks('onLoadDocument', {
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        connectionConfig: createConnectionConfig(),
      });
      document.getText('local').insert(0, 'local state');
      const newerDatabaseDocument = new Y.Doc();
      newerDatabaseDocument.getText('remote').insert(0, 'newer database state');
      await pool.query('update pages set ydoc = $1 where id = $2', [
        Y.encodeStateAsUpdate(newerDatabaseDocument),
        page.id,
      ]);

      await server.hocuspocus.hooks('onStoreDocument', {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: server.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
      });

      const stored = await pool.query<{ ydoc: Buffer }>('select ydoc from pages where id = $1', [
        page.id,
      ]);
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
      expect(storedDocument.getText('local').toString()).toBe('local state');
      expect(storedDocument.getText('remote').toString()).toBe('newer database state');
    });

    it('clears the committed writer when metadata publication fails after commit', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Post-commit page');
      const postCommitLogger = mockLogger();
      let committed = false;
      const connect = vi.fn(async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text === 'COMMIT') committed = true;
            return result;
          },
          release: () => client.release(),
        };
      });
      const postCommitPool = {
        connect,
        query: (text: string, values?: unknown[]) => {
          if (committed) throw new Error('metadata fanout unavailable');
          return pool.query(text, values);
        },
      } as unknown as typeof pool;
      const postCommitServer = createCollabServer({
        port: 0,
        pool: postCommitPool,
        logger: postCommitLogger,
        permissionRevalidationMs: 0,
      });
      const document = new Document(page.id);
      document.getText('content').insert(0, 'durably committed');
      const context = { user: { id: owner.id }, permission: 'admin' as const };
      const metaRoomName = `page-meta:${owner.id}`;
      postCommitServer.hocuspocus.documents.set(metaRoomName, new Document(metaRoomName));
      postCommitServer.hocuspocus.documents.set(page.id, document);
      await postCommitServer.hocuspocus.hooks('onChange', {
        clientsCount: 1,
        context,
        document,
        documentName: page.id,
        instance: postCommitServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: null,
        update: Y.encodeStateAsUpdate(document),
      });

      try {
        await postCommitServer.hocuspocus.hooks('onStoreDocument', {
          clientsCount: 1,
          context,
          document,
          documentName: page.id,
          instance: postCommitServer.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
        await postCommitServer.hocuspocus.hooks('onDisconnect', {
          clientsCount: 0,
          context,
          document,
          documentName: page.id,
          instance: postCommitServer.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });

        expect(connect).toHaveBeenCalledTimes(1);
        expect(postCommitLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('metadata publication failed after commit'),
        );
        const stored = await pool.query<{ ydoc: Buffer }>('select ydoc from pages where id = $1', [
          page.id,
        ]);
        const storedDocument = new Y.Doc();
        Y.applyUpdate(storedDocument, new Uint8Array(stored.rows[0]?.ydoc ?? []));
        expect(storedDocument.getText('content').toString()).toBe('durably committed');
      } finally {
        postCommitServer.hocuspocus.documents.delete(page.id);
        postCommitServer.hocuspocus.documents.delete(metaRoomName);
        await postCommitServer.destroy();
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
      await waitFor(
        () => !server.hocuspocus.documents.has(page.id),
        5_000,
        'reconnected provider document to unload',
      );
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
      const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
      const serverConnection = activeDocument?.getConnections().find((connection) => {
        const connectionContext = connection.context as { user?: { id?: string } } | undefined;
        return connectionContext?.user?.id === user.id;
      });
      if (!serverConnection) throw new Error('Missing server-side coalescing connection');
      const connectionContext = serverConnection.context as
        | { permissionCheck?: Promise<void> }
        | undefined;
      await connectionContext?.permissionCheck;

      // Spy on pool.connect calls — each persistDocument call acquires a client,
      // so connect call count after the initial sync fence reflects persistence
      // and per-update authorization work from the edits below.
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

  describe('active permission revalidation', () => {
    it('does not roll an unpersisted collaborative title back during periodic access refresh', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Persisted old title');
      const periodicServer = createCollabServer({
        port: 0,
        pool,
        logger: mockLogger(),
        permissionRevalidationMs: 10,
      });
      const activeDocument = new Document(page.id);
      activeDocument.getText('title').insert(0, 'Pending collaborative title');
      periodicServer.hocuspocus.documents.set(page.id, activeDocument);

      try {
        await sleep(100);
        expect(activeDocument.getText('title').toString()).toBe('Pending collaborative title');
        const persisted = await pool.query<{ title: string }>(
          'select title from pages where id = $1',
          [page.id],
        );
        expect(persisted.rows[0]?.title).toBe('Persisted old title');
      } finally {
        periodicServer.hocuspocus.documents.delete(page.id);
        await periodicServer.destroy();
      }
    });

    it('canonically recovers missed permission, metadata, and deletion events', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Canonical title');
      const deletedPage = await createTestPage(pool, owner.id, 'Deleted while offline');
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, viewer.id],
      );
      const pageRevision = await pool.query<{ access_revision: string }>(
        'select get_page_access_revision($1)::text as access_revision',
        [page.id],
      );
      const deletedPageRevision = await pool.query<{ access_revision: string }>(
        'select get_page_access_revision($1)::text as access_revision',
        [deletedPage.id],
      );

      const viewerConnection = {
        context: {
          user: { id: viewer.id },
          permission: 'view',
          accessRevision: pageRevision.rows[0]?.access_revision,
        },
        readOnly: true,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const deletedConnection = {
        context: {
          user: { id: owner.id },
          permission: 'admin',
          accessRevision: deletedPageRevision.rows[0]?.access_revision,
        },
        readOnly: false,
        send: vi.fn(),
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const pageDocument = new Document(page.id);
      const deletedDocument = new Document(deletedPage.id);
      const metaDocument = new Document(`page-meta:${owner.id}`);
      metaDocument.getMap('pageIndex').set(page.id, { title: 'Stale title' });
      metaDocument.getMap('pageIndex').set(deletedPage.id, { title: deletedPage.title });
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        viewerConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      vi.spyOn(deletedDocument, 'getConnections').mockReturnValue([
        deletedConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, pageDocument);
      server.hocuspocus.documents.set(deletedPage.id, deletedDocument);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      // These mutations represent events lost while the LISTEN connection was down.
      await pool.query(
        `delete from shares
         where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
        [page.id, viewer.id],
      );
      await pool.query('update pages set is_deleted = true where id = $1', [deletedPage.id]);

      try {
        await reconcileActiveCollaborationState(server, pool, logger);

        expect(viewerConnection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
        expect(deletedConnection.close).toHaveBeenCalledWith({
          code: 4402,
          reason: 'Page deleted',
        });
        expect(metaDocument.getMap('pageIndex').get(page.id)).toEqual(
          expect.objectContaining({ title: 'Canonical title' }),
        );
        expect(metaDocument.getMap('pageIndex').has(deletedPage.id)).toBe(false);
      } finally {
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(deletedPage.id);
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('disconnects a viewer after their only account grant is revoked', async () => {
      const owner = await createTestUser(pool);
      const viewer = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, permission
         ) values ('page', $1, $2, $3, 'view')`,
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
      await pool.query(
        `delete from shares
         where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
        [page.id, viewer.id],
      );

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

    it('disconnects page and metadata sockets when their session is deleted', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const pageRevision = await pool.query<{ access_revision: string }>(
        'select get_page_access_revision($1)::text as access_revision',
        [page.id],
      );
      const metaRevision = await pool.query<{ access_revision: string }>(
        'select coalesce(max(version), 0)::text as access_revision from workspace_access_versions',
      );
      const pageConnection = {
        context: {
          user: { id: user.id },
          permission: 'admin',
          sessionToken: session.token,
          accessRevision: pageRevision.rows[0]?.access_revision,
        },
        readOnly: false,
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const metaConnection = {
        context: {
          user: { id: user.id },
          permission: null,
          sessionToken: session.token,
          accessRevision: metaRevision.rows[0]?.access_revision,
        },
        readOnly: true,
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const pageDocument = new Document(page.id);
      const metaDocument = new Document(`page-meta:${user.id}`);
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        metaConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, pageDocument);
      server.hocuspocus.documents.set(`page-meta:${user.id}`, metaDocument);
      await pool.query('delete from sessions where token = $1', [session.token]);

      try {
        await revalidateActivePageConnections(server, pool, logger);
        expect(pageConnection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Access revoked',
        });
        expect(metaConnection.close).toHaveBeenCalledWith({
          code: 4401,
          reason: 'Session expired',
        });
        expect(pageConnection.sendStateless).toHaveBeenCalledWith(
          expect.stringMatching(/"type":"permission_snapshot".*"permission":null/),
        );
        expect(metaConnection.sendStateless).toHaveBeenCalledWith(
          expect.stringMatching(/"type":"permission_snapshot".*"permission":null/),
        );
      } finally {
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(`page-meta:${user.id}`);
      }
    });
  });

  describe('database event publication', () => {
    it('suppresses delayed grant toasts after a permission update or revoke', async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is not set');
      const owner = await createTestUser(pool);
      const recipient = await createTestUser(pool);
      const updatedPage = await createTestPage(pool, owner.id, 'Updated before grant delivery');
      const revokedPage = await createTestPage(pool, owner.id, 'Revoked before grant delivery');
      for (const page of [updatedPage, revokedPage]) {
        await pool.query(
          `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
           values ('page', $1, $2, $3, 'edit')`,
          [page.id, owner.id, recipient.id],
        );
      }

      type GrantBarrier = {
        reached(): void;
        release: Promise<void>;
      };
      let grantBarrier: GrantBarrier | undefined;
      const gatedPool = new Proxy(pool, {
        get(target, property) {
          if (property === 'query') {
            return async (text: string, values?: unknown[]) => {
              if (text.includes("coalesce(sharer.name, 'Someone')") && grantBarrier) {
                const barrier = grantBarrier;
                barrier.reached();
                await barrier.release;
              }
              return target.query(text, values);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const eventLogger = mockLogger();
      const eventDebug = eventLogger.debug as unknown as ReturnType<typeof vi.fn>;
      const eventInfo = eventLogger.info as unknown as ReturnType<typeof vi.fn>;
      const eventServer = createCollabServer({
        port: 0,
        pool: gatedPool,
        logger: eventLogger,
        databaseUrl,
        permissionRevalidationMs: 0,
      });
      const connection = { sendStateless: vi.fn(), close: vi.fn() };
      const metaDocument = new Document(`page-meta:${recipient.id}`);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      eventServer.hocuspocus.documents.set(`page-meta:${recipient.id}`, metaDocument);
      await eventServer.listen();

      const publishDelayedGrant = async (
        page: { id: string; title: string },
        mutate: () => Promise<unknown>,
      ): Promise<void> => {
        let markReached: (() => void) | undefined;
        let release: (() => void) | undefined;
        const reached = new Promise<void>((resolve) => {
          markReached = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        grantBarrier = { reached: () => markReached?.(), release: released };
        await pool.query("select pg_notify('share_event', $1)", [
          JSON.stringify({
            type: 'grant_received',
            entityType: 'page',
            entityId: page.id,
            entityTitle: page.title,
            sharedByName: 'Test User',
            targetUserId: recipient.id,
            permission: 'edit',
            message: `Granted edit access to ${page.title}`,
          }),
        ]);
        await Promise.race([
          reached,
          sleep(5_000).then(() => {
            throw new Error('Timed out waiting for canonical grant validation');
          }),
        ]);
        await mutate();
        release?.();
        await waitFor(
          () =>
            eventDebug.mock.calls.some((call: unknown[]) =>
              String(call[0]).includes(`stale grant ignored for user=${recipient.id}`),
            ),
          5_000,
          'stale grant suppression',
        );
        grantBarrier = undefined;
      };

      try {
        await waitFor(
          () =>
            eventInfo.mock.calls.some((call: unknown[]) =>
              String(call[0]).includes('[listen] subscribed and reconciled'),
            ),
          5_000,
          'event listener subscription',
        );

        await publishDelayedGrant(updatedPage, () =>
          pool.query(
            `update shares set permission = 'view'
             where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
            [updatedPage.id, recipient.id],
          ),
        );
        eventDebug.mockClear();
        await publishDelayedGrant(revokedPage, () =>
          pool.query(
            `delete from shares
             where entity_type = 'page' and entity_id = $1 and recipient_user_id = $2`,
            [revokedPage.id, recipient.id],
          ),
        );

        expect(
          connection.sendStateless.mock.calls.some(([payload]) =>
            String(payload).includes('"type":"grant_received"'),
          ),
        ).toBe(false);
      } finally {
        grantBarrier = undefined;
        eventServer.hocuspocus.documents.delete(`page-meta:${recipient.id}`);
        await eventServer.destroy();
      }
    });

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
        new Date(deletedAt.getTime() + 1_000),
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

    it('evicts an already-connected anonymous viewer after recursive folder deletion', async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is not set');
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO folders (id, name, position, created_by, created_at, updated_at)
         VALUES ($1, 'Folder deleted with anonymous viewer', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, owner.id, 'Public descendant');
      await pool.query(
        `UPDATE pages
         SET parent_id = $1, public_permission = 'view'
         WHERE id = $2`,
        [folderId, page.id],
      );

      const eventLogger = mockLogger();
      const eventServer = createCollabServer({
        port: 0,
        pool,
        logger: eventLogger,
        databaseUrl,
        permissionRevalidationMs: 0,
      });
      await eventServer.listen();
      const eventPort = (eventServer as unknown as { address: { port: number } }).address.port;
      const statelessMessages: string[] = [];
      const closeEvents: Array<{ code: number; reason: string }> = [];
      const anonymousProvider = new HocuspocusProvider({
        url: `ws://localhost:${eventPort}`,
        name: page.id,
        document: new Y.Doc(),
        // Isolate LISTEN delivery from client-message access revalidation winning
        // the race immediately after the deletion transaction commits.
        awareness: null,
        token: `anon:${crypto.randomUUID()}`,
        onStateless: ({ payload }) => statelessMessages.push(payload),
        onClose: ({ event }) => closeEvents.push({ code: event.code, reason: event.reason }),
      });

      try {
        const listenerInfo = eventLogger.info as unknown as ReturnType<typeof vi.fn>;
        await waitFor(
          () =>
            listenerInfo.mock.calls.some((call: unknown[]) =>
              String(call[0]).includes('[listen] subscribed and reconciled'),
            ),
          5_000,
          'folder deletion listener subscription',
        );
        await waitFor(() => anonymousProvider.synced, 5_000, 'anonymous provider to sync');
        await waitFor(
          () =>
            (eventServer.hocuspocus.documents.get(page.id) as Document | undefined)
              ?.getConnections()
              .some(
                (connection) =>
                  (connection.context as { user?: { isAnonymous?: boolean } } | undefined)?.user
                    ?.isAnonymous === true,
              ) === true,
          5_000,
          'anonymous connection to become active',
        );

        const deletionClient = await pool.connect();
        try {
          await deletionClient.query('BEGIN');
          await deletionClient.query(
            `UPDATE pages
             SET is_deleted = true, deleted_at = statement_timestamp(), updated_at = now()
             WHERE id = $1`,
            [page.id],
          );
          await deletionClient.query(
            `UPDATE folders
             SET is_deleted = true, deleted_at = statement_timestamp(), updated_at = now()
             WHERE id = $1`,
            [folderId],
          );
          await deletionClient.query("SELECT pg_notify('folder_deleted', $1)", [
            JSON.stringify({ folderId }),
          ]);
          await deletionClient.query('COMMIT');
        } catch (error) {
          await deletionClient.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          deletionClient.release();
        }

        const expectedDeletionMessage = JSON.stringify({
          type: 'entity_deleted',
          entityType: 'page',
          entityId: page.id,
        });
        await waitFor(
          () => statelessMessages.includes(expectedDeletionMessage),
          5_000,
          'anonymous viewer deletion notification',
        );
        await waitFor(
          () => closeEvents.some((event) => event.reason === 'Page deleted'),
          5_000,
          'anonymous viewer protocol close',
        );

        expect(closeEvents).toContainEqual({ code: 1000, reason: 'Page deleted' });
        expect(anonymousProvider.synced).toBe(false);
        await waitFor(
          () => {
            const activeDocument = eventServer.hocuspocus.documents.get(page.id) as
              | Document
              | undefined;
            return !activeDocument || activeDocument.getConnections().length === 0;
          },
          5_000,
          'anonymous connection to be removed from the active page',
        );
      } finally {
        anonymousProvider.destroy();
        await eventServer.destroy();
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

    it('publishes a folder deletion without acquiring a nested pool lease', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (id, name, position, created_by, created_at, updated_at)
         values ($1, 'Single lease folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      await pool.query('update folders set is_deleted = true, deleted_at = now() where id = $1', [
        folderId,
      ]);

      const connection = { send: vi.fn(), sendStateless: vi.fn(), close: vi.fn() };
      const metaDocument = new Document(`page-meta:${owner.id}`);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);
      let connectCalls = 0;
      const singleLeasePool = new Proxy(pool, {
        get(target, property) {
          if (property === 'connect') {
            return async () => {
              connectCalls += 1;
              if (connectCalls > 1) throw new Error('nested pool lease requested');
              return target.connect();
            };
          }
          if (property === 'query') {
            return async () => {
              throw new Error('nested pool query requested');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        await publishFolderDeletion(server.hocuspocus, singleLeasePool, folderId, logger);
        expect(connectCalls).toBe(1);
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

    it('ignores a delayed page deletion after the page is restored behind the workspace lock', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Restored before publication');
      await pool.query(
        `update pages
         set is_deleted = true, deleted_at = now(), deletion_batch_id = gen_random_uuid()
         where id = $1`,
        [page.id],
      );

      const pageConnection = { sendStateless: vi.fn(), close: vi.fn() };
      const pageDocument = new Document(page.id);
      const metaDocument = new Document(`page-meta:${owner.id}`);
      metaDocument.getMap('pageIndex').set(page.id, { title: page.title });
      metaDocument.getMap('accessPermissions').set(page.id, 'admin');
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, pageDocument);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      let transactionOpen = false;
      let publication: Promise<void> | undefined;
      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        publication = publishPageDeletion(server.hocuspocus, pool, page.id, logger);
        await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'delayed page deletion publication to wait behind restore',
        );
        await blocker.query(
          `update pages
           set is_deleted = false, deleted_at = null, deletion_batch_id = null
           where id = $1`,
          [page.id],
        );
        await blocker.query('commit');
        transactionOpen = false;
        await publication;

        expect(pageConnection.sendStateless).not.toHaveBeenCalled();
        expect(pageConnection.close).not.toHaveBeenCalled();
        expect(metaDocument.getMap('pageIndex').has(page.id)).toBe(true);
        expect(metaDocument.getMap('accessPermissions').get(page.id)).toBe('admin');
      } finally {
        if (transactionOpen) await blocker.query('rollback').catch(() => undefined);
        blocker.release();
        await publication?.catch(() => undefined);
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('ignores every delayed folder deletion side effect after the folder is restored', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (id, name, position, created_by, created_at, updated_at)
         values ($1, 'Restored folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, owner.id, 'Restored descendant');
      const deletionBatchId = crypto.randomUUID();
      await pool.query(
        `update pages
         set parent_id = $1, is_deleted = true, deleted_at = now(), deletion_batch_id = $2
         where id = $3`,
        [folderId, deletionBatchId, page.id],
      );
      await pool.query(
        `update folders
         set is_deleted = true, deleted_at = now(), deletion_batch_id = $1
         where id = $2`,
        [deletionBatchId, folderId],
      );

      const pageConnection = { sendStateless: vi.fn(), close: vi.fn() };
      const metaConnection = { send: vi.fn(), sendStateless: vi.fn(), close: vi.fn() };
      const pageDocument = new Document(page.id);
      const metaDocument = new Document(`page-meta:${owner.id}`);
      metaDocument.getMap('pageIndex').set(page.id, { title: page.title });
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        metaConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, pageDocument);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      let transactionOpen = false;
      let publication: Promise<void> | undefined;
      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        publication = publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
        await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'delayed folder deletion publication to wait behind restore',
        );
        await blocker.query(
          `update folders
           set is_deleted = false, deleted_at = null, deletion_batch_id = null
           where id = $1`,
          [folderId],
        );
        await blocker.query(
          `update pages
           set is_deleted = false, deleted_at = null, deletion_batch_id = null
           where id = $1`,
          [page.id],
        );
        await blocker.query('commit');
        transactionOpen = false;
        await publication;

        expect(pageConnection.sendStateless).not.toHaveBeenCalled();
        expect(pageConnection.close).not.toHaveBeenCalled();
        expect(metaConnection.sendStateless).not.toHaveBeenCalled();
        expect(metaDocument.getMap('pageIndex').has(page.id)).toBe(true);
      } finally {
        if (transactionOpen) await blocker.query('rollback').catch(() => undefined);
        blocker.release();
        await publication?.catch(() => undefined);
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('excludes a descendant restored and moved before delayed folder publication', async () => {
      const owner = await createTestUser(pool);
      const folderId = crypto.randomUUID();
      await pool.query(
        `insert into folders (id, name, position, created_by, created_at, updated_at)
         values ($1, 'Still deleted folder', '0', $2, now(), now())`,
        [folderId, owner.id],
      );
      const page = await createTestPage(pool, owner.id, 'Moved restored descendant');
      const deletionBatchId = crypto.randomUUID();
      await pool.query(
        `update pages
         set parent_id = $1, is_deleted = true, deleted_at = now(), deletion_batch_id = $2
         where id = $3`,
        [folderId, deletionBatchId, page.id],
      );
      await pool.query(
        `update folders
         set is_deleted = true, deleted_at = now(), deletion_batch_id = $1
         where id = $2`,
        [deletionBatchId, folderId],
      );

      const pageConnection = { sendStateless: vi.fn(), close: vi.fn() };
      const metaConnection = { send: vi.fn(), sendStateless: vi.fn(), close: vi.fn() };
      const pageDocument = new Document(page.id);
      const metaDocument = new Document(`page-meta:${owner.id}`);
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        metaConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, pageDocument);
      server.hocuspocus.documents.set(`page-meta:${owner.id}`, metaDocument);

      const blocker = await pool.connect();
      const blockerPid = (blocker as unknown as { processID: number }).processID;
      let transactionOpen = false;
      let publication: Promise<void> | undefined;
      try {
        await blocker.query('begin');
        transactionOpen = true;
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${owner.id}`,
        ]);

        publication = publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
        await waitForExactWorkspaceLockWaiter(
          pool,
          blockerPid,
          'delayed folder deletion publication to wait behind descendant restore',
        );
        await blocker.query(
          `update pages
           set parent_id = null, is_deleted = false, deleted_at = null, deletion_batch_id = null
           where id = $1`,
          [page.id],
        );
        await blocker.query('commit');
        transactionOpen = false;
        await publication;

        expect(pageConnection.sendStateless).not.toHaveBeenCalled();
        expect(pageConnection.close).not.toHaveBeenCalled();
        expect(metaDocument.getMap('pageIndex').has(page.id)).toBe(true);
        expect(metaConnection.sendStateless).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'entity_deleted',
            entityType: 'folder',
            entityId: folderId,
          }),
        );
      } finally {
        if (transactionOpen) await blocker.query('rollback').catch(() => undefined);
        blocker.release();
        await publication?.catch(() => undefined);
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
      }
    });

    it('publishes a purged page deletion to every stale active metadata index', async () => {
      const pageId = crypto.randomUUID();
      const firstUserId = crypto.randomUUID();
      const secondUserId = crypto.randomUUID();
      const unrelatedUserId = crypto.randomUUID();
      const pageConnection = { sendStateless: vi.fn(), close: vi.fn() };
      const pageDocument = new Document(pageId);
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(pageId, pageDocument);

      const metaDocuments = [firstUserId, secondUserId].map((userId) => {
        const document = new Document(`page-meta:${userId}`);
        document.getMap('pageIndex').set(pageId, { title: 'Purged page' });
        document.getMap('accessPermissions').set(pageId, 'view');
        server.hocuspocus.documents.set(`page-meta:${userId}`, document);
        return document;
      });
      const unrelatedDocument = new Document(`page-meta:${unrelatedUserId}`);
      unrelatedDocument.getMap('pageIndex').set(crypto.randomUUID(), { title: 'Unrelated page' });
      server.hocuspocus.documents.set(`page-meta:${unrelatedUserId}`, unrelatedDocument);

      try {
        await publishPageDeletion(server.hocuspocus, pool, pageId, logger);

        expect(pageConnection.close).toHaveBeenCalledWith({ code: 4402, reason: 'Page deleted' });
        for (const document of metaDocuments) {
          expect(document.getMap('pageIndex').has(pageId)).toBe(false);
          expect(document.getMap('accessPermissions').has(pageId)).toBe(false);
        }
        expect(unrelatedDocument.getMap('pageIndex').has(pageId)).toBe(false);
        expect(unrelatedDocument.getMap('accessPermissions').has(pageId)).toBe(false);
        expect(unrelatedDocument.getMap('backlinksVersion').has(pageId)).toBe(false);
      } finally {
        server.hocuspocus.documents.delete(pageId);
        server.hocuspocus.documents.delete(`page-meta:${firstUserId}`);
        server.hocuspocus.documents.delete(`page-meta:${secondUserId}`);
        server.hocuspocus.documents.delete(`page-meta:${unrelatedUserId}`);
      }
    });

    it('reconciles purged folder descendants without broadcasting a purged folder ID', async () => {
      const folderId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const pageConnection = { sendStateless: vi.fn(), close: vi.fn() };
      const metaConnection = { send: vi.fn(), sendStateless: vi.fn(), close: vi.fn() };
      const pageDocument = new Document(pageId);
      const metaDocument = new Document(`page-meta:${userId}`);
      metaDocument.getMap('pageIndex').set(pageId, { title: 'Purged descendant' });
      metaDocument.getMap('accessPermissions').set(pageId, 'view');
      vi.spyOn(pageDocument, 'getConnections').mockReturnValue([
        pageConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      vi.spyOn(metaDocument, 'getConnections').mockReturnValue([
        metaConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(pageId, pageDocument);
      server.hocuspocus.documents.set(`page-meta:${userId}`, metaDocument);

      try {
        await publishFolderDeletion(server.hocuspocus, pool, folderId, logger);

        expect(pageConnection.close).toHaveBeenCalledWith({ code: 4402, reason: 'Page deleted' });
        expect(metaDocument.getMap('pageIndex').has(pageId)).toBe(false);
        expect(metaDocument.getMap('accessPermissions').has(pageId)).toBe(false);
        expect(metaConnection.sendStateless).not.toHaveBeenCalled();
      } finally {
        server.hocuspocus.documents.delete(pageId);
        server.hocuspocus.documents.delete(`page-meta:${userId}`);
      }
    });

    it('closes active page connections when canonical deletion metadata lookup fails', async () => {
      const owner = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id, 'Deleted before metadata failure');
      await pool.query('update pages set is_deleted = true, deleted_at = now() where id = $1', [
        page.id,
      ]);
      const connection = {
        sendStateless: vi.fn(),
        close: vi.fn(),
      };
      const activeDocument = new Document(page.id);
      vi.spyOn(activeDocument, 'getConnections').mockReturnValue([
        connection,
      ] as unknown as ReturnType<Document['getConnections']>);
      server.hocuspocus.documents.set(page.id, activeDocument);
      server.hocuspocus.documents.set(
        `page-meta:${owner.id}`,
        new Document(`page-meta:${owner.id}`),
      );
      const failingPool = new Proxy(pool, {
        get(target, property) {
          if (property === 'connect') {
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(clientTarget, clientProperty) {
                  if (clientProperty === 'query') {
                    return async (text: string, values?: unknown[]) => {
                      if (text.includes('with page_info as')) {
                        expect(connection.close).not.toHaveBeenCalled();
                        throw new Error('metadata unavailable');
                      }
                      return clientTarget.query(text, values);
                    };
                  }
                  const value: unknown = Reflect.get(clientTarget, clientProperty, clientTarget);
                  return typeof value === 'function' ? value.bind(clientTarget) : value;
                },
              });
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        await expect(
          publishPageDeletion(server.hocuspocus, failingPool, page.id, logger),
        ).rejects.toThrow('metadata unavailable');
        expect(connection.close).toHaveBeenCalledWith({ code: 4402, reason: 'Page deleted' });
        expect(connection.sendStateless).toHaveBeenCalledWith(
          expect.stringContaining('"type":"entity_deleted"'),
        );
      } finally {
        server.hocuspocus.documents.delete(page.id);
        server.hocuspocus.documents.delete(`page-meta:${owner.id}`);
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

    it('does not persist or evict the room when a view-only connection disconnects', async () => {
      const isolatedPool = {
        query: vi.fn(async () => {
          throw new Error('viewer disconnect must not query');
        }),
        connect: vi.fn(async () => {
          throw new Error('viewer disconnect must not persist');
        }),
      } as unknown as typeof pool;
      const isolatedServer = createCollabServer({
        port: 0,
        pool: isolatedPool,
        logger: mockLogger(),
        permissionRevalidationMs: 0,
      });
      const documentName = crypto.randomUUID();
      const document = new Document(documentName);
      const remainingConnection = { close: vi.fn() };
      vi.spyOn(document, 'getConnections').mockReturnValue([
        remainingConnection,
      ] as unknown as ReturnType<Document['getConnections']>);
      isolatedServer.hocuspocus.documents.set(documentName, document);

      try {
        await isolatedServer.hocuspocus.hooks('onDisconnect', {
          clientsCount: 1,
          context: { user: { id: crypto.randomUUID() }, permission: 'view' },
          document,
          documentName,
          instance: isolatedServer.hocuspocus,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
          socketId: crypto.randomUUID(),
        });
        expect(isolatedPool.connect).not.toHaveBeenCalled();
        expect(isolatedPool.query).not.toHaveBeenCalled();
        expect(remainingConnection.close).not.toHaveBeenCalled();
      } finally {
        isolatedServer.hocuspocus.documents.delete(documentName);
        await isolatedServer.destroy();
      }
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
      const context = { user: { id: user.id }, permission: 'admin' as const };
      await failingServer.hocuspocus.hooks('onChange', {
        clientsCount: 1,
        context,
        document: doc,
        documentName,
        instance: failingServer.hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: crypto.randomUUID(),
        transactionOrigin: null,
        update: Y.encodeStateAsUpdate(doc),
      });
      const payload: onDisconnectPayload = {
        clientsCount: 0,
        context,
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
    it('accepts the authenticated users non-null image as canonical awareness identity', async () => {
      const user = await createTestUser(pool);
      const image = 'https://cdn.example.com/test-user.png';
      await pool.query('update users set avatar_url = null, image = $1 where id = $2', [
        image,
        user.id,
      ]);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const source = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      const observer = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      try {
        await waitFor(() => source.synced && observer.synced, 5_000, 'image providers to sync');
        source.setAwarenessField('user', {
          ...canonicalTestAwarenessUser(user.id),
          avatar: image,
        });
        await waitFor(
          () =>
            Array.from(observer.awareness?.getStates().values() ?? []).some(
              (state) => state.user?.avatar === image,
            ),
          5_000,
          'canonical image awareness to propagate',
        );
      } finally {
        source.destroy();
        observer.destroy();
      }
    });

    it('prefers the Better Auth image when the legacy avatar differs', async () => {
      const user = await createTestUser(pool);
      const image = 'https://cdn.example.com/better-auth-image.png';
      await pool.query('update users set avatar_url = $1, image = $2 where id = $3', [
        'https://cdn.example.com/legacy-avatar.png',
        image,
        user.id,
      ]);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const source = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });
      const observer = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: new Y.Doc(),
        token: session.token,
      });

      try {
        await waitFor(() => source.synced && observer.synced, 5_000, 'avatar providers to sync');
        source.setAwarenessField('user', {
          ...canonicalTestAwarenessUser(user.id),
          avatar: image,
        });
        await waitFor(
          () =>
            Array.from(observer.awareness?.getStates().values() ?? []).some(
              (state) => state.user?.avatar === image,
            ),
          5_000,
          'Better Auth image awareness to propagate',
        );
      } finally {
        source.destroy();
        observer.destroy();
      }
    });

    it('keeps a third provider connected after bundled awareness sync', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const firstDocument = new Y.Doc();
      const secondDocument = new Y.Doc();
      const thirdDocument = new Y.Doc();
      const first = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: firstDocument,
        token: session.token,
      });
      const second = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: secondDocument,
        token: session.token,
      });
      const thirdClosed = vi.fn();
      let third: HocuspocusProvider | undefined;

      try {
        await waitFor(() => first.synced && second.synced, 5_000, 'source providers to sync');
        first.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        second.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () =>
            first.awareness?.getStates().has(secondDocument.clientID) === true &&
            second.awareness?.getStates().has(firstDocument.clientID) === true,
          5_000,
          'two canonical awareness states to reach the server',
        );

        third = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: thirdDocument,
          token: session.token,
          onClose: thirdClosed,
        });
        await waitFor(
          () =>
            third?.synced === true &&
            third.awareness?.getStates().has(firstDocument.clientID) === true &&
            third.awareness?.getStates().has(secondDocument.clientID) === true,
          5_000,
          'third provider to receive bundled awareness',
        );
        const firstState = third.awareness?.getStates().get(firstDocument.clientID);
        const secondState = third.awareness?.getStates().get(secondDocument.clientID);
        const firstClock = third.awareness?.meta.get(firstDocument.clientID)?.clock;
        const secondClock = third.awareness?.meta.get(secondDocument.clientID)?.clock;
        if (
          firstState === undefined ||
          secondState === undefined ||
          firstClock === undefined ||
          secondClock === undefined
        ) {
          throw new Error('Missing bundled awareness state');
        }
        third.configuration.websocketProvider.webSocket?.send(
          encodeAwarenessMessage(page.id, [
            { clientId: firstDocument.clientID, clock: firstClock, state: firstState },
            { clientId: secondDocument.clientID, clock: secondClock, state: secondState },
          ]),
        );
        await sleep(100);
        expect(thirdClosed).not.toHaveBeenCalled();

        third.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () => first.awareness?.getStates().has(thirdDocument.clientID) === true,
          5_000,
          'third provider awareness to propagate after initial sync',
        );
      } finally {
        first.destroy();
        second.destroy();
        third?.destroy();
      }
    });

    it('accepts a stale bundled echo that the server previously sent to a real provider', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const firstDocument = new Y.Doc();
      const secondDocument = new Y.Doc();
      const echoDocument = new Y.Doc();
      const first = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: firstDocument,
        token: session.token,
      });
      const second = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: secondDocument,
        token: session.token,
      });
      const echoClosed = vi.fn();
      let echo: HocuspocusProvider | undefined;

      try {
        await waitFor(() => first.synced && second.synced, 5_000, 'source providers to sync');
        first.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        second.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return (
              activeDocument?.awareness.getStates().has(firstDocument.clientID) === true &&
              activeDocument.awareness.getStates().has(secondDocument.clientID) === true
            );
          },
          5_000,
          'source awareness to reach the server',
        );

        echo = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: echoDocument,
          token: session.token,
          onClose: echoClosed,
        });
        await waitFor(
          () =>
            echo?.synced === true &&
            echo.awareness?.getStates().has(firstDocument.clientID) === true &&
            echo.awareness?.getStates().has(secondDocument.clientID) === true,
          5_000,
          'echo provider to receive bundled awareness',
        );

        const firstState = echo.awareness?.getStates().get(firstDocument.clientID);
        const secondState = echo.awareness?.getStates().get(secondDocument.clientID);
        const firstClock = echo.awareness?.meta.get(firstDocument.clientID)?.clock;
        const secondClock = echo.awareness?.meta.get(secondDocument.clientID)?.clock;
        if (
          firstState === undefined ||
          secondState === undefined ||
          firstClock === undefined ||
          secondClock === undefined
        ) {
          throw new Error('Missing server-delivered awareness bundle');
        }

        first.setAwarenessField('cursor', { anchor: 1, head: 1 });
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return (
              (activeDocument?.awareness.meta.get(firstDocument.clientID)?.clock ?? 0) > firstClock
            );
          },
          5_000,
          'source awareness clock to advance',
        );

        echo.configuration.websocketProvider.webSocket?.send(
          encodeAwarenessMessage(page.id, [
            { clientId: firstDocument.clientID, clock: firstClock, state: firstState },
          ]),
        );
        await sleep(100);
        expect(echoClosed).not.toHaveBeenCalled();

        echo.configuration.websocketProvider.webSocket?.send(
          encodeAwarenessMessage(page.id, [
            { clientId: firstDocument.clientID, clock: firstClock, state: firstState },
            { clientId: secondDocument.clientID, clock: secondClock, state: secondState },
          ]),
        );
        await sleep(100);
        expect(echoClosed).not.toHaveBeenCalled();

        echo.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        echoDocument.getText('content').insert(0, 'write after stale awareness echo');
        await waitFor(
          () => firstDocument.getText('content').toString() === 'write after stale awareness echo',
          5_000,
          'write after stale awareness echo to converge',
        );
      } finally {
        first.destroy();
        second.destroy();
        echo?.destroy();
      }
    });

    it('allows duplicate providers for one authenticated Y.Doc client identity', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const sharedDocument = new Y.Doc();
      const observerDocument = new Y.Doc();
      const firstClosed = vi.fn();
      const duplicateClosed = vi.fn();
      const first = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: session.token,
        onClose: firstClosed,
      });
      const duplicate = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: session.token,
        onClose: duplicateClosed,
      });
      const observer = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: observerDocument,
        token: session.token,
      });

      try {
        await waitFor(
          () => first.synced && duplicate.synced && observer.synced,
          5_000,
          'duplicate providers to sync',
        );
        first.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () =>
            observer.awareness?.getStates().get(sharedDocument.clientID)?.user?.name ===
            'Test User',
          5_000,
          'first duplicate awareness to propagate',
        );

        duplicate.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        duplicate.setAwarenessField('cursor', { anchor: 2, head: 2 });
        await waitFor(
          () => observer.awareness?.getStates().get(sharedDocument.clientID)?.cursor?.anchor === 2,
          5_000,
          'second duplicate awareness to propagate',
        );
        expect(firstClosed).not.toHaveBeenCalled();
        expect(duplicateClosed).not.toHaveBeenCalled();

        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const clockBeforeDisconnect = activeDocument?.awareness.meta.get(
          sharedDocument.clientID,
        )?.clock;
        if (clockBeforeDisconnect === undefined) {
          throw new Error('Missing shared awareness clock before duplicate disconnect');
        }
        first.destroy();
        await waitFor(
          () => {
            const currentDocument = server.hocuspocus.documents.get(page.id) as
              | Document
              | undefined;
            return (
              currentDocument?.awareness.getStates().has(sharedDocument.clientID) === true &&
              (currentDocument.awareness.meta.get(sharedDocument.clientID)?.clock ?? 0) >
                clockBeforeDisconnect
            );
          },
          5_000,
          'remaining duplicate to reannounce awareness',
        );
        expect(duplicateClosed).not.toHaveBeenCalled();

        sharedDocument.getText('content').insert(0, 'duplicate provider write');
        await waitFor(
          () => observerDocument.getText('content').toString() === 'duplicate provider write',
          5_000,
          'duplicate provider write to converge',
        );
      } finally {
        first.destroy();
        duplicate.destroy();
        observer.destroy();
      }
    });

    it('rejects a different authenticated principal that reuses an active client identity', async () => {
      const owner = await createTestUser(pool);
      const intruder = await createTestUser(pool);
      const ownerSession = await createTestSession(pool, owner.id);
      const intruderSession = await createTestSession(pool, intruder.id);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'edit')`,
        [page.id, owner.id, intruder.id],
      );
      const sharedDocument = new Y.Doc();
      const ownerClosed = vi.fn();
      const intruderClosed = vi.fn();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: ownerSession.token,
        onClose: ownerClosed,
      });
      let intruderProvider: HocuspocusProvider | undefined;

      try {
        await waitFor(() => ownerProvider.synced, 5_000, 'client identity owner to sync');
        ownerProvider.setAwarenessField('user', canonicalTestAwarenessUser(owner.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return (
              activeDocument?.awareness.getStates().get(sharedDocument.clientID)?.user?.name ===
              'Test User'
            );
          },
          5_000,
          'owned client identity to reach the server',
        );

        intruderProvider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: sharedDocument,
          awareness: null,
          token: intruderSession.token,
          onClose: intruderClosed,
        });
        await waitFor(() => intruderProvider?.synced === true, 5_000, 'intruder provider to sync');
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const intruderConnection = activeDocument?.getConnections().find((connection) => {
          const connectionContext = connection.context as { user?: { id?: string } } | undefined;
          return connectionContext?.user?.id === intruder.id;
        });
        if (!activeDocument || !intruderConnection) {
          throw new Error('Missing intruder awareness connection');
        }
        const currentClock = activeDocument.awareness.meta.get(sharedDocument.clientID)?.clock;
        if (currentClock === undefined) throw new Error('Missing owned awareness clock');
        const intruderServerClose = vi.spyOn(intruderConnection, 'close');
        try {
          intruderProvider.configuration.websocketProvider.webSocket?.send(
            encodeAwarenessMessage(page.id, [
              {
                clientId: sharedDocument.clientID,
                clock: currentClock + 1,
                state: { user: canonicalTestAwarenessUser(intruder.id) },
              },
            ]),
          );
          await waitFor(
            () =>
              intruderClosed.mock.calls.length > 0 &&
              intruderServerClose.mock.calls.some((call) => call[0]?.code === 4403),
            5_000,
            'cross-principal client identity reuse to close',
          );
        } finally {
          intruderServerClose.mockRestore();
        }

        expect(ownerClosed).not.toHaveBeenCalled();
        expect(activeDocument.awareness.getStates().get(sharedDocument.clientID)?.user).toEqual(
          canonicalTestAwarenessUser(owner.id),
        );
      } finally {
        ownerProvider.destroy();
        intruderProvider?.destroy();
      }
    });

    it('rejects an anonymous principal that reuses an authenticated client identity', async () => {
      const owner = await createTestUser(pool);
      const ownerSession = await createTestSession(pool, owner.id);
      const page = await createTestPage(pool, owner.id);
      await pool.query("update pages set public_permission = 'view' where id = $1", [page.id]);
      const sharedDocument = new Y.Doc();
      const ownerClosed = vi.fn();
      const anonymousClosed = vi.fn();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: ownerSession.token,
        onClose: ownerClosed,
      });
      let anonymousProvider: HocuspocusProvider | undefined;

      try {
        await waitFor(() => ownerProvider.synced, 5_000, 'authenticated identity owner to sync');
        ownerProvider.setAwarenessField('user', canonicalTestAwarenessUser(owner.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return activeDocument?.awareness.getStates().has(sharedDocument.clientID) === true;
          },
          5_000,
          'authenticated client identity to reach the server',
        );

        anonymousProvider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: sharedDocument,
          awareness: null,
          token: `anon:${owner.id}`,
          onClose: anonymousClosed,
        });
        await waitFor(
          () => anonymousProvider?.synced === true,
          5_000,
          'anonymous collision provider to sync',
        );
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const anonymousConnection = activeDocument?.getConnections().find((connection) => {
          const connectionContext = connection.context as
            | { user?: { id?: string; isAnonymous?: boolean } }
            | undefined;
          return connectionContext?.user?.id === owner.id && connectionContext.user.isAnonymous;
        });
        const currentClock = activeDocument?.awareness.meta.get(sharedDocument.clientID)?.clock;
        if (!activeDocument || !anonymousConnection || currentClock === undefined) {
          throw new Error('Missing anonymous collision connection');
        }
        const anonymousServerClose = vi.spyOn(anonymousConnection, 'close');
        try {
          anonymousProvider.configuration.websocketProvider.webSocket?.send(
            encodeAwarenessMessage(page.id, [
              {
                clientId: sharedDocument.clientID,
                clock: currentClock + 1,
                state: {
                  user: {
                    name: getAnonymousName(owner.id),
                    color: getStableColor(owner.id),
                    avatar: null,
                    emoji: getAnimalEmoji(owner.id),
                    isAnonymous: true,
                  },
                },
              },
            ]),
          );
          await waitFor(
            () =>
              anonymousClosed.mock.calls.length > 0 &&
              anonymousServerClose.mock.calls.some((call) => call[0]?.code === 4403),
            5_000,
            'anonymous client identity collision to close',
          );
        } finally {
          anonymousServerClose.mockRestore();
        }

        expect(ownerClosed).not.toHaveBeenCalled();
        expect(activeDocument.awareness.getStates().get(sharedDocument.clientID)?.user).toEqual(
          canonicalTestAwarenessUser(owner.id),
        );
      } finally {
        ownerProvider.destroy();
        anonymousProvider?.destroy();
      }
    });

    it('rejects forged user fields from a same-principal duplicate provider', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const sharedDocument = new Y.Doc();
      const firstClosed = vi.fn();
      const duplicateClosed = vi.fn();
      const first = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: session.token,
        onClose: firstClosed,
      });
      let duplicate: HocuspocusProvider | undefined;

      try {
        await waitFor(() => first.synced, 5_000, 'forgery source provider to sync');
        first.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return activeDocument?.awareness.getStates().has(sharedDocument.clientID) === true;
          },
          5_000,
          'forgery source awareness to reach the server',
        );

        duplicate = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: sharedDocument,
          token: session.token,
          onClose: duplicateClosed,
        });
        await waitFor(() => duplicate?.synced === true, 5_000, 'forgery duplicate to sync');
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const closeSpies = (activeDocument?.getConnections() ?? []).map((connection) =>
          vi.spyOn(connection, 'close'),
        );
        try {
          duplicate.setAwarenessField('user', {
            ...canonicalTestAwarenessUser(user.id),
            name: 'Forged Same Principal',
          });
          await waitFor(
            () =>
              duplicateClosed.mock.calls.length > 0 &&
              closeSpies.some((spy) => spy.mock.calls.some((call) => call[0]?.code === 4403)),
            5_000,
            'same-principal forged user to close',
          );
        } finally {
          for (const closeSpy of closeSpies) closeSpy.mockRestore();
        }

        expect(firstClosed).not.toHaveBeenCalled();
        expect(activeDocument?.awareness.getStates().get(sharedDocument.clientID)?.user).toEqual(
          canonicalTestAwarenessUser(user.id),
        );
      } finally {
        first.destroy();
        duplicate?.destroy();
      }
    });

    it('rejects null removal from an unbound same-principal duplicate', async () => {
      const user = await createTestUser(pool);
      const session = await createTestSession(pool, user.id);
      const page = await createTestPage(pool, user.id);
      const sharedDocument = new Y.Doc();
      const firstClosed = vi.fn();
      const duplicateClosed = vi.fn();
      const first = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: sharedDocument,
        token: session.token,
        onClose: firstClosed,
      });
      let duplicate: HocuspocusProvider | undefined;

      try {
        await waitFor(() => first.synced, 5_000, 'null-removal source to sync');
        first.setAwarenessField('user', canonicalTestAwarenessUser(user.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            return activeDocument?.awareness.getStates().has(sharedDocument.clientID) === true;
          },
          5_000,
          'null-removal source awareness to reach the server',
        );

        duplicate = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: sharedDocument,
          awareness: null,
          token: session.token,
          onClose: duplicateClosed,
        });
        await waitFor(() => duplicate?.synced === true, 5_000, 'unbound duplicate to sync');
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const unboundConnection = activeDocument?.getConnections().find((connection) => {
          const connectionContext = connection.context as
            | { awarenessClientId?: number; user?: { id?: string } }
            | undefined;
          return (
            connectionContext?.user?.id === user.id &&
            connectionContext.awarenessClientId === undefined
          );
        });
        const currentClock = activeDocument?.awareness.meta.get(sharedDocument.clientID)?.clock;
        if (!activeDocument || !unboundConnection || currentClock === undefined) {
          throw new Error('Missing unbound same-principal duplicate');
        }
        const duplicateServerClose = vi.spyOn(unboundConnection, 'close');
        try {
          duplicate.configuration.websocketProvider.webSocket?.send(
            encodeAwarenessMessage(page.id, [
              { clientId: sharedDocument.clientID, clock: currentClock + 1, state: null },
            ]),
          );
          await waitFor(
            () =>
              duplicateClosed.mock.calls.length > 0 &&
              duplicateServerClose.mock.calls.some((call) => call[0]?.code === 4403),
            5_000,
            'unbound duplicate null removal to close',
          );
        } finally {
          duplicateServerClose.mockRestore();
        }

        expect(firstClosed).not.toHaveBeenCalled();
        expect(activeDocument.awareness.getStates().has(sharedDocument.clientID)).toBe(true);
      } finally {
        first.destroy();
        duplicate?.destroy();
      }
    });

    it('binds raw awareness updates to one authenticated client identity', async () => {
      const owner = await createTestUser(pool);
      const attacker = await createTestUser(pool);
      const page = await createTestPage(pool, owner.id);
      await pool.query(
        `insert into shares (entity_type, entity_id, shared_by, recipient_user_id, permission)
         values ('page', $1, $2, $3, 'view')`,
        [page.id, owner.id, attacker.id],
      );
      const ownerSession = await createTestSession(pool, owner.id);
      const attackerSession = await createTestSession(pool, attacker.id);
      const ownerDocument = new Y.Doc();
      const ownerProvider = new HocuspocusProvider({
        url: `ws://localhost:${port}`,
        name: page.id,
        document: ownerDocument,
        token: ownerSession.token,
      });
      const attackers: HocuspocusProvider[] = [];

      const sendAdversarialAwareness = async (
        createMessage: (attackerDocument: Y.Doc) => Uint8Array,
      ): Promise<void> => {
        const attackerDocument = new Y.Doc();
        const closed = vi.fn();
        const provider = new HocuspocusProvider({
          url: `ws://localhost:${port}`,
          name: page.id,
          document: attackerDocument,
          token: attackerSession.token,
          onClose: closed,
        });
        attackers.push(provider);
        await waitFor(() => provider.synced, 5_000, 'awareness attacker to sync');
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const serverConnection = activeDocument?.getConnections().find((connection) => {
          const connectionContext = connection.context as { user?: { id?: string } } | undefined;
          return connectionContext?.user?.id === attacker.id;
        });
        if (!serverConnection) throw new Error('Missing server-side attacker connection');
        const serverClose = vi.spyOn(serverConnection, 'close');

        try {
          provider.configuration.websocketProvider.webSocket?.send(createMessage(attackerDocument));
          await waitFor(
            () =>
              closed.mock.calls.length > 0 &&
              serverClose.mock.calls.some((call) => call[0]?.code === 4403),
            5_000,
            'invalid awareness sender to close with server code 4403',
          );
          expect(serverClose).toHaveBeenCalledWith(expect.objectContaining({ code: 4403 }));
        } finally {
          serverClose.mockRestore();
          provider.destroy();
        }
      };

      try {
        await waitFor(() => ownerProvider.synced, 5_000, 'awareness owner to sync');
        ownerProvider.setAwarenessField('user', canonicalTestAwarenessUser(owner.id));
        await waitFor(
          () => {
            const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
            const state = activeDocument?.awareness.getStates().get(ownerDocument.clientID) as
              | { user?: { name?: string } }
              | undefined;
            return (
              state?.user?.name === 'Test User' &&
              activeDocument?.awareness.meta.get(ownerDocument.clientID)?.clock !== undefined
            );
          },
          5_000,
          'owner canonical awareness state and clock to reach the server',
        );
        const activeDocument = server.hocuspocus.documents.get(page.id) as Document | undefined;
        const ownerAwarenessState = activeDocument?.awareness
          .getStates()
          .get(ownerDocument.clientID);
        const ownerAwarenessClock = activeDocument?.awareness.meta.get(
          ownerDocument.clientID,
        )?.clock;
        if (ownerAwarenessState === undefined || ownerAwarenessClock === undefined) {
          throw new Error('Missing server-owned awareness state');
        }

        await sendAdversarialAwareness((attackerDocument) =>
          encodeAwarenessMessage(page.id, [
            {
              clientId: ownerDocument.clientID,
              clock: ownerAwarenessClock,
              state: ownerAwarenessState,
            },
            {
              clientId: attackerDocument.clientID,
              clock: 100,
              state: {
                user: { name: 'Forged Owner', color: '#000000', avatar: 'forged.png' },
              },
            },
          ]),
        );
        await sendAdversarialAwareness((attackerDocument) =>
          encodeAwarenessMessage(page.id, [
            {
              clientId: attackerDocument.clientID,
              clock: 100,
              state: {
                user: { name: 'Forged Owner', color: '#000000', avatar: 'forged.png' },
              },
            },
          ]),
        );
        await sendAdversarialAwareness(() =>
          encodeAwarenessMessage(page.id, [
            {
              clientId: ownerDocument.clientID,
              clock: ownerAwarenessClock + 1,
              state: { user: canonicalTestAwarenessUser(owner.id) },
            },
          ]),
        );
        await sendAdversarialAwareness(() =>
          encodeAwarenessMessage(page.id, [
            {
              clientId: ownerDocument.clientID,
              clock: ownerAwarenessClock,
              state: {
                user: canonicalTestAwarenessUser(attacker.id),
              },
            },
          ]),
        );
        await sendAdversarialAwareness(() =>
          encodeAwarenessMessage(page.id, [
            {
              clientId: ownerDocument.clientID,
              clock: ownerAwarenessClock + 2,
              state: null,
            },
          ]),
        );

        await sleep(50);
        expect(ownerProvider.awareness?.getStates().get(ownerDocument.clientID)?.user).toEqual(
          canonicalTestAwarenessUser(owner.id),
        );
        const awarenessUsers = Array.from(ownerProvider.awareness?.getStates().values() ?? [])
          .map((state) => state.user as { name?: string } | undefined)
          .filter(Boolean);
        expect(awarenessUsers).not.toContainEqual(
          expect.objectContaining({ name: 'Forged Owner' }),
        );
      } finally {
        for (const provider of attackers) provider.destroy();
        ownerProvider.destroy();
      }
    });

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
      provider1.setAwarenessField('user', canonicalTestAwarenessUser(user.id));

      await waitFor(
        () => {
          for (const state of provider2.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Test User') {
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
      provider1.setAwarenessField('user', canonicalTestAwarenessUser(user.id));

      await waitFor(
        () => {
          for (const state of provider2.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Test User') {
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
        ([, state]) => (state as { user?: { name?: string } }).user?.name === 'Test User',
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
      provider1.setAwarenessField('user', canonicalTestAwarenessUser(user.id));

      await waitFor(
        () => {
          for (const state of observerProvider.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Test User') {
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

      reconnectedProvider.setAwarenessField('user', canonicalTestAwarenessUser(user.id));

      await waitFor(
        () => {
          for (const state of observerProvider.awareness?.getStates().values() ?? []) {
            if ((state as { user?: { name?: string } }).user?.name === 'Test User') {
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
