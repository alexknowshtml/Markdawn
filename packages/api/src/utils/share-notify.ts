import type { ShareEntityType, ShareEventAction, SharePermission } from '@markdawn/shared';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';

const MAX_NOTIFICATION_TEXT_LENGTH = 256;

const boundedNotificationText = (value: string): string => {
  if (value.length <= MAX_NOTIFICATION_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`;
};

interface ShareEventBase {
  entityType: ShareEntityType;
  entityId: string;
  permission?: SharePermission;
  targetUserId?: string;
  metaUserIds?: string[];
  entityTitle?: string;
  sharedByName?: string;
  message?: string;
}

function fireShareEvent(
  action: ShareEventAction,
  params: ShareEventBase,
  executor: QueryExecutor = db,
) {
  const payload = {
    type: 'share_event',
    action,
    entityType: params.entityType,
    entityId: params.entityId,
    ...(params.permission !== undefined && { permission: params.permission }),
    ...(params.targetUserId !== undefined && { targetUserId: params.targetUserId }),
    ...(params.metaUserIds !== undefined && { metaUserIds: [...new Set(params.metaUserIds)] }),
    ...(params.message !== undefined && { message: boundedNotificationText(params.message) }),
  };
  return executeQuery(executor, "SELECT pg_notify('share_event', $1)", [JSON.stringify(payload)]);
}

export async function notifyShareGrant(
  params: ShareEventBase,
  executor: QueryExecutor = db,
): Promise<void> {
  await fireShareEvent('grant', params, executor);
  if (params.targetUserId && params.entityTitle && params.sharedByName) {
    const invitePayload = {
      type: 'invite_received',
      entityType: params.entityType,
      entityId: params.entityId,
      entityTitle: boundedNotificationText(params.entityTitle),
      sharedByName: boundedNotificationText(params.sharedByName),
      targetUserId: params.targetUserId,
      ...(params.message !== undefined && { message: boundedNotificationText(params.message) }),
    };
    await executeQuery(executor, "SELECT pg_notify('share_event', $1)", [
      JSON.stringify(invitePayload),
    ]);
  }
}

export function notifyShareUpdate(params: ShareEventBase, executor: QueryExecutor = db) {
  return fireShareEvent('update', params, executor);
}

export function notifyShareRevoke(params: ShareEventBase, executor: QueryExecutor = db) {
  return fireShareEvent('revoke', params, executor);
}

export function notifyShareRecompute(params: ShareEventBase, executor: QueryExecutor = db) {
  return fireShareEvent('recompute', params, executor);
}

export function notifyWorkspaceEvent(
  action: 'member_added' | 'member_removed' | 'role_changed',
  ownerId: string,
  memberId: string,
  message?: string,
  executor: QueryExecutor = db,
) {
  const payload = {
    type: 'workspace_event',
    action,
    ownerId,
    memberId,
    ...(message !== undefined && { message: boundedNotificationText(message) }),
  };
  return executeQuery(executor, "SELECT pg_notify('workspace_event', $1)", [
    JSON.stringify(payload),
  ]);
}
