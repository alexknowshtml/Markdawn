import type { ShareEntityType, SharePermission } from './page.js';

/**
 * Discriminated action for a share-related realtime event.
 * - `grant`: a new share was created (email invite)
 * - `update`: an existing share's permission changed (link or email)
 * - `revoke`: a share was deleted or set to private
 * - `recompute`: permissions changed indirectly and must be reloaded from the DB
 */
export type ShareEventAction = 'grant' | 'update' | 'revoke' | 'recompute';
export type StatelessShareEventAction = Exclude<ShareEventAction, 'recompute'>;

/**
 * Canonical payload sent over PostgreSQL LISTEN/NOTIFY from the API server
 * to the collab (WebSocket) server.
 *
 * `targetUserId` determines which connections are affected for grant/update/revoke events:
 * - `undefined` → affects all anonymous connections (link share changes)
 * - a user ID  → affects that specific authenticated connection (email invite changes)
 *
 * `recompute` ignores `targetUserId` and asks the collab server to reload effective
 * permissions for every active connection on the affected page(s).
 *
 * `message` is a human-readable description of what happened, intended for
 * display as a toast on the client. The collab server passes it through
 * to the WebSocket stateless message unchanged.
 */
export interface ShareEventPayload {
  type: 'share_event';
  action: ShareEventAction;
  entityType: ShareEntityType;
  entityId: string;
  permission?: SharePermission;
  targetUserId?: string;
  /** Additional signed-in users whose metadata queries must refresh. */
  metaUserIds?: string[];
  /** Refresh metadata/access versions without revalidating active page connections. */
  metaOnly?: boolean;
  /** Human-readable toast message for the affected user(s). */
  message?: string;
}

/**
 * Stateless message sent over WebSocket from the collab server to affected
 * client connections. Clients use this to update their readOnly state,
 * show toasts, or redirect — no permission logic lives on the client.
 *
 * The permission value is sent as-is (including `'admin'`). Clients are
 * responsible for mapping `'admin'` to `'edit'` for read-only state but
 * may use the raw value for display purposes (e.g. toast messages).
 */
export interface StatelessShareMessage {
  type: 'share_event';
  action: StatelessShareEventAction;
  permission?: SharePermission;
  message?: string;
}

/**
 * Authoritative effective permission for a collaboration connection.
 *
 * `accessRevision` is a durable, transactionally updated access-state revision
 * encoded as a decimal string. Clients compare it as an integer and must
 * ignore older snapshots.
 * Unlike `share_event`, this message is state rather than a toast/invalidation.
 */
export interface PermissionSnapshotMessage {
  type: 'permission_snapshot';
  permission: SharePermission | null;
  accessRevision: string;
}

const permissionRank = (permission: SharePermission | null): number => {
  if (permission === 'admin') return 3;
  if (permission === 'edit') return 2;
  if (permission === 'view') return 1;
  return 0;
};

/**
 * Equal revisions occur at natural expiry boundaries because no database
 * mutation increments the durable access counter. At an equal revision, only
 * the same permission or a downgrade is safe; an upgrade requires a newer
 * revision from an explicit access mutation.
 */
export function shouldApplyPermissionSnapshot(
  current: Pick<PermissionSnapshotMessage, 'permission' | 'accessRevision'> | null,
  incoming: Pick<PermissionSnapshotMessage, 'permission' | 'accessRevision'>,
): boolean {
  if (!current) return true;
  const currentRevision = BigInt(current.accessRevision);
  const incomingRevision = BigInt(incoming.accessRevision);
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision;
  return permissionRank(incoming.permission) <= permissionRank(current.permission);
}

export interface EntityDeletedMessage {
  type: 'entity_deleted';
  entityType: ShareEntityType;
  entityId: string;
  pageId?: string;
}
