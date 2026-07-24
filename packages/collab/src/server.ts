import { Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import {
  COLLAB_DOCUMENT_RELOAD_REASONS,
  DEFAULT_MAX_AWARENESS_PAYLOAD_BYTES,
  DEFAULT_MAX_COLLAB_PAYLOAD_BYTES,
  isPageMetaRoomName,
  MAX_YDOC_BYTES,
} from '@markdawn/shared';
import type { Pool } from 'pg';
import type * as Y from 'yjs';
import { createAccessVerifier } from './accessVerifier';
import { rememberOutboundAwarenessEntries } from './awarenessPolicy';
import { CollabVerificationError } from './collabErrors';
import type { CollabServerConfig } from './collabServerConfig';
import { createConnectionEstablishmentHook } from './connectionEstablishment';
import {
  publishFolderDeletion,
  publishPageDeletion,
  reconcileDeletionOverflow,
} from './deletionPublications';
import { createDocumentChangeHooks } from './documentChangeHooks';
import { reconcileActiveDocumentContent } from './documentContentReconciliation';
import { createDocumentFlusher } from './documentFlusher';
import { createDocumentLoader } from './documentLoader';
import { createDocumentWriteCoordinator } from './documentWriteCoordinator';
import { createGrantNotifier } from './grantNotifications';
import { createHocuspocusV3LifecycleHooks } from './hocuspocusV3Adapter';
import {
  createPageRenamePublication,
  rebuildActivePageMetaDocuments,
} from './metadataPublications';
import { installNotificationRuntime } from './notificationRuntime';
import { createPageTitleRuntime, type PageTitleRuntime } from './pageTitleRuntime';
import { revalidateActivePageConnections } from './permission-handler';
import { createProtocolMessageHandler } from './protocolMessageHandler';
import { createSessionAuthenticator } from './sessionAuthenticator';
import { querySessionState } from './sessionQueries';
import { createWriteAdmissionRuntime } from './writeAdmissionRuntime';

export { sanitizeCanonicalYjsUpdate, yjsUpdateTouchesTitle } from './collaborationProtocol';
export type { CollabServerConfig } from './collabServerConfig';
export { publishFolderDeletion, publishPageDeletion } from './deletionPublications';
export { publishPageRename } from './metadataPublications';
export { broadcastWikiLinkPresentationInvalidation } from './wikiLinkInvalidation';

const APPLICATION_FENCE_TIMEOUT_MS = 10_000;
export type CollaborationRuntime = { titles: PageTitleRuntime };
export type CollabServer = Server & { readonly collaboration: CollaborationRuntime };

function isMetaRoom(documentName: string): boolean {
  return isPageMetaRoomName(documentName);
}

/** Canonical recovery after a LISTEN subscription (initial or reconnected). */
export async function reconcileActiveCollaborationState(
  server: Server,
  pool: Pool,
  logger: Logger,
): Promise<void> {
  const titleRuntime =
    'collaboration' in server ? (server as CollabServer).collaboration.titles : null;
  await Promise.all([
    titleRuntime?.reconcileActive() ?? Promise.resolve(),
    reconcileDeletionOverflow(server.hocuspocus, pool, logger),
    revalidateActivePageConnections(server, pool, logger),
  ]);
}

export function createCollabServer(config: CollabServerConfig) {
  const {
    port,
    pool,
    logger,
    debounceMs = 500,
    maxDebounceMs = 3000,
    permissionRevalidationMs = 5000,
    applicationFenceTimeoutMs = APPLICATION_FENCE_TIMEOUT_MS,
    maxPayloadBytes = DEFAULT_MAX_COLLAB_PAYLOAD_BYTES,
    maxAwarenessPayloadBytes = DEFAULT_MAX_AWARENESS_PAYLOAD_BYTES,
    maxDocumentBytes = MAX_YDOC_BYTES,
  } = config;
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error('maxPayloadBytes must be a positive integer');
  }
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
    throw new Error('maxDocumentBytes must be a positive integer');
  }
  if (!Number.isInteger(maxAwarenessPayloadBytes) || maxAwarenessPayloadBytes < 1) {
    throw new Error('maxAwarenessPayloadBytes must be a positive integer');
  }
  if (!Number.isInteger(applicationFenceTimeoutMs) || applicationFenceTimeoutMs < 1) {
    throw new Error('applicationFenceTimeoutMs must be a positive integer');
  }
  const accessVerifier = createAccessVerifier(pool, logger);
  const getSessionState = async (userId: string, sessionToken: string) => {
    const state = await querySessionState(pool, { userId, sessionToken });
    if (!state) throw new CollabVerificationError('Missing session state');
    return state;
  };
  const {
    assertAnonymousPageAccess,
    assertMetaRoomAccess,
    assertPageAccess,
    lockActivePage,
    lockDocumentAccessMutation,
  } = accessVerifier;
  const {
    blockDocumentForReload,
    blockOversizedDocument,
    canPersistPendingDocument,
    clearPersistedWriters,
    getConnectionResolutionPrincipals,
    getDocumentChangeVersion,
    getDocumentSizeEstimate,
    getDocumentContentHash,
    isDocumentBlocked,
    resetDocumentState,
    recordDocumentChange,
    setDocumentSizeEstimate,
    setDocumentContentHash,
    withDocumentContentLock,
  } = createDocumentWriteCoordinator({
    pool,
    logger,
    maxDocumentBytes,
    getHocuspocus: () => server.hocuspocus,
    access: accessVerifier,
  });
  const titleRuntime = createPageTitleRuntime({
    pool,
    logger,
    getHocuspocus: () => server.hocuspocus,
    blockDocument: blockDocumentForReload,
  });
  const writeAdmissionRuntime = createWriteAdmissionRuntime({
    timeoutMs: applicationFenceTimeoutMs,
    titles: titleRuntime,
    blockDocument: blockDocumentForReload,
  });

  const flushDocument = createDocumentFlusher({
    pool,
    logger,
    maxDocumentBytes,
    titles: titleRuntime,
    getHocuspocus: () => server.hocuspocus,
    getDocumentChangeVersion,
    getConnectionResolutionPrincipals,
    canPersistPendingDocument,
    clearPersistedWriters,
    setDocumentSizeEstimate,
    getDocumentContentHash,
    setDocumentContentHash,
    withDocumentContentLock,
    blockDocumentForReload,
    blockOversizedDocument,
  });

  const documentChangeHooks = createDocumentChangeHooks({
    logger,
    maxDocumentBytes,
    titles: titleRuntime,
    isMetaRoom,
    isDocumentBlocked,
    getActiveDocument: (documentName) =>
      server.hocuspocus.documents.get(documentName) as Y.Doc | undefined,
    getDocumentSizeEstimate,
    setDocumentSizeEstimate,
    blockOversizedDocument,
    recordDocumentChange,
    resetDocumentState,
    flushDocument,
  });

  const server = new Server({
    port,
    onRequest: async ({ request, response }) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/health') return;

      try {
        await pool.query('select 1');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
      } catch (error) {
        logger.error(`[health] database health check failed: ${error}`);
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'unavailable' }));
      }
      // Prevent Hocuspocus from writing its default response after this hook.
      await Promise.reject();
    },
    lifecycleHooks: createHocuspocusV3LifecycleHooks({ rememberOutboundAwarenessEntries }),
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: createSessionAuthenticator({
      pool,
      logger,
      isDocumentBlocked,
      isMetaRoom,
      assertAnonymousPageAccess,
      assertPageAccess: (documentName, userId, sessionToken) =>
        assertPageAccess(documentName, userId, sessionToken, pool),
      assertMetaRoomAccess,
    }),
    connected: createConnectionEstablishmentHook({
      isMetaRoom,
      getSessionState,
      assertAnonymousPageAccess,
      assertPageAccess: (documentName, userId, sessionToken) =>
        assertPageAccess(documentName, userId, sessionToken, pool),
    }),
    beforeHandleMessage: createProtocolMessageHandler({
      pool,
      maxAwarenessPayloadBytes,
      isMetaRoom,
      getSessionState,
      lockDocumentAccessMutation,
      lockActivePage,
      assertAnonymousPageAccess: (documentName, client) =>
        assertAnonymousPageAccess(documentName, client),
      assertPageAccess: (documentName, userId, sessionToken, client) =>
        assertPageAccess(documentName, userId, sessionToken, client),
      writeAdmissions: writeAdmissionRuntime,
    }),
    onLoadDocument: createDocumentLoader({
      pool,
      logger,
      maxDocumentBytes,
      titles: titleRuntime,
      isMetaRoom,
      resetDocumentState,
      setDocumentSizeEstimate,
      setDocumentContentHash,
      assertMetaRoomAccess,
      getSessionState,
      lockDocumentAccessMutation,
      lockActivePage,
      assertAnonymousPageAccess: (documentName, client) =>
        assertAnonymousPageAccess(documentName, client),
      assertPageAccess: (documentName, userId, sessionToken, client) =>
        assertPageAccess(documentName, userId, sessionToken, client),
    }),
    ...documentChangeHooks,
    extensions: [],
  });
  const collabServer = Object.assign(server, {
    collaboration: { titles: titleRuntime } satisfies CollaborationRuntime,
  });
  server.webSocketServer.options.maxPayload = maxPayloadBytes;

  const handlePageRenamed = createPageRenamePublication({
    hocuspocus: server.hocuspocus,
    pool,
    logger,
    titles: titleRuntime,
    lockDocumentAccessMutation,
    lockActivePage,
  });

  const disposeNotifications = installNotificationRuntime({
    server,
    pool,
    logger,
    ...(config.databaseUrl !== undefined ? { databaseUrl: config.databaseUrl } : {}),
    permissionRevalidationMs,
    publications: {
      grantReceived: createGrantNotifier(server, pool, logger),
      pageContentReplaced: async (pageId) => {
        blockDocumentForReload(pageId, 4500, COLLAB_DOCUMENT_RELOAD_REASONS.CONTENT_REPLACED);
        await rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
          reconcileTitles: false,
        });
      },
      pageRenamed: handlePageRenamed,
      pageDeleted: (pageId) => publishPageDeletion(server.hocuspocus, pool, pageId, logger),
      folderDeleted: (folderId) => publishFolderDeletion(server.hocuspocus, pool, folderId, logger),
      rebuildMetadata: (options) =>
        rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
          ...options,
          reconcileActiveTitles: titleRuntime.reconcileActive,
        }),
      reconcileAll: () => reconcileActiveCollaborationState(server, pool, logger),
      reconcileContent: () =>
        reconcileActiveDocumentContent({
          pool,
          hocuspocus: server.hocuspocus,
          logger,
          isMetaRoom,
          getLoadedContentHash: getDocumentContentHash,
          withDocumentContentLock,
          blockDocumentForReload,
        }),
      reconcileDeletions: () => reconcileDeletionOverflow(server.hocuspocus, pool, logger),
    },
  });
  const originalDestroy = server.destroy.bind(server);
  Object.defineProperty(server, 'destroy', {
    async value() {
      await writeAdmissionRuntime.completeAll();
      await disposeNotifications();
      return originalDestroy();
    },
    writable: true,
    configurable: true,
  });

  return collabServer;
}
