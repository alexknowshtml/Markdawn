export const MAX_YDOC_BYTES = 16 * 1024 * 1024;
// A reconnect may send the whole supported document in one Yjs sync frame.
// Leave room for the protocol envelope so the transport never rejects a
// document that the persistence layer considers valid.
export const DEFAULT_MAX_COLLAB_PAYLOAD_BYTES = MAX_YDOC_BYTES + 64 * 1024;

// Presence data contains cursors and small user metadata, never document
// content. Keep it independently bounded so a public collaborator cannot use
// awareness fan-out to amplify a document-sized payload to every peer.
export const DEFAULT_MAX_AWARENESS_PAYLOAD_BYTES = 64 * 1024;

// Hocuspocus per-document closes preserve the reason but normalize the code to
// 1000 in the browser provider. Keep these terminal reasons shared so server
// and client eviction behavior cannot drift independently.
export const COLLAB_TERMINAL_REASONS = {
  ACCESS_REVOKED: 'Access revoked',
  PAGE_DELETED: 'Page deleted',
  PERMISSION_VERIFICATION_FAILED: 'Permission verification failed',
  SESSION_EXPIRED: 'Session expired',
} as const;
