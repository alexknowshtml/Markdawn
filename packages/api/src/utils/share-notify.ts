import type { ShareEntityType, SharePermission } from '@markdawn/shared';
import { pool } from '../db/connection';

interface ShareEventBase {
  entityType: ShareEntityType;
  entityId: string;
  permission?: SharePermission;
  targetUserId?: string;
}

function fireShareEvent(action: 'grant' | 'update' | 'revoke', params: ShareEventBase) {
  const payload = {
    type: 'share_event',
    action,
    entityType: params.entityType,
    entityId: params.entityId,
    ...(params.permission !== undefined && { permission: params.permission }),
    ...(params.targetUserId !== undefined && { targetUserId: params.targetUserId }),
  };
  return pool.query("SELECT pg_notify('share_event', $1)", [JSON.stringify(payload)]);
}

export function notifyShareGrant(params: ShareEventBase) {
  return fireShareEvent('grant', params);
}

export function notifyShareUpdate(params: ShareEventBase) {
  return fireShareEvent('update', params);
}

export function notifyShareRevoke(params: ShareEventBase) {
  return fireShareEvent('revoke', params);
}

export function notifyWorkspaceEvent(
  action: 'member_added' | 'member_removed' | 'role_changed',
  ownerId: string,
  memberId: string,
) {
  const payload = { type: 'workspace_event', action, ownerId, memberId };
  return pool.query("SELECT pg_notify('workspace_event', $1)", [JSON.stringify(payload)]);
}
