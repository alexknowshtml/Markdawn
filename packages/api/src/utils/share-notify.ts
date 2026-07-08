import type { ShareEntityType, ShareEventAction, SharePermission } from '@markdawn/shared';
import { query } from '../db/query';

interface ShareEventBase {
  entityType: ShareEntityType;
  entityId: string;
  permission?: SharePermission;
  targetUserId?: string;
  entityTitle?: string;
  sharedByName?: string;
  message?: string;
}

function fireShareEvent(action: ShareEventAction, params: ShareEventBase) {
  const payload = {
    type: 'share_event',
    action,
    entityType: params.entityType,
    entityId: params.entityId,
    ...(params.permission !== undefined && { permission: params.permission }),
    ...(params.targetUserId !== undefined && { targetUserId: params.targetUserId }),
    ...(params.message !== undefined && { message: params.message }),
  };
  return query("SELECT pg_notify('share_event', $1)", [JSON.stringify(payload)]);
}

export function notifyShareGrant(params: ShareEventBase) {
  const events: Promise<unknown>[] = [fireShareEvent('grant', params)];
  if (params.targetUserId && params.entityTitle && params.sharedByName) {
    const invitePayload = {
      type: 'invite_received',
      entityType: params.entityType,
      entityId: params.entityId,
      entityTitle: params.entityTitle,
      sharedByName: params.sharedByName,
      targetUserId: params.targetUserId,
      message: params.message,
    };
    events.push(query("SELECT pg_notify('share_event', $1)", [JSON.stringify(invitePayload)]));
  }
  return Promise.all(events);
}

export function notifyShareUpdate(params: ShareEventBase) {
  return fireShareEvent('update', params);
}

export function notifyShareRevoke(params: ShareEventBase) {
  return fireShareEvent('revoke', params);
}

export function notifyShareRecompute(params: ShareEventBase) {
  return fireShareEvent('recompute', params);
}

export function notifyWorkspaceEvent(
  action: 'member_added' | 'member_removed' | 'role_changed',
  ownerId: string,
  memberId: string,
  message?: string,
) {
  const payload = {
    type: 'workspace_event',
    action,
    ownerId,
    memberId,
    ...(message !== undefined && { message }),
  };
  return query("SELECT pg_notify('workspace_event', $1)", [JSON.stringify(payload)]);
}
