export const MAX_YDOC_BYTES = 16 * 1024 * 1024;
// A reconnect may send the whole supported document in one Yjs sync frame.
// Leave room for the protocol envelope so the transport never rejects a
// document that the persistence layer considers valid.
export const DEFAULT_MAX_COLLAB_PAYLOAD_BYTES = MAX_YDOC_BYTES + 64 * 1024;

// Presence data contains cursors and small user metadata, never document
// content. Keep it independently bounded so a public collaborator cannot use
// awareness fan-out to amplify a document-sized payload to every peer.
export const DEFAULT_MAX_AWARENESS_PAYLOAD_BYTES = 64 * 1024;

export const PAGE_META_ROOM_PREFIX = 'page-meta:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getPageMetaRoomName = (userId: string): string => `${PAGE_META_ROOM_PREFIX}${userId}`;

export const parsePageMetaRoomName = (documentName: string): string | null => {
  if (!documentName.startsWith(PAGE_META_ROOM_PREFIX)) return null;
  const userId = documentName.slice(PAGE_META_ROOM_PREFIX.length);
  return UUID_PATTERN.test(userId) ? userId : null;
};

export const isPageMetaRoomName = (documentName: string): boolean =>
  documentName.startsWith(PAGE_META_ROOM_PREFIX);

export const COLLAB_DOCUMENT_RELOAD_REASONS = {
  CONTENT_REPLACED: 'Document content was replaced',
  RELOAD_REQUIRED: 'Document reload required',
} as const;

export const COLLAB_GUEST_IDENTITY_EXPIRED_REASON = 'Guest identity expired';

// Hocuspocus per-document closes preserve the reason but normalize the code to
// 1000 in the browser provider. Keep these terminal reasons shared so server
// and client eviction behavior cannot drift independently.
export const COLLAB_TERMINAL_REASONS = {
  ACCESS_REVOKED: 'Access revoked',
  PAGE_DELETED: 'Page deleted',
  PERMISSION_VERIFICATION_FAILED: 'Permission verification failed',
  SESSION_EXPIRED: 'Session expired',
} as const;
