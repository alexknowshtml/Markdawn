import {
  getUnicodeCodePointLength,
  type ShareEntityType,
  type ShareEventAction,
  type SharePermission,
  truncateUnicodeCodePoints,
} from '@markdawn/shared';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';

const MAX_NOTIFICATION_TEXT_LENGTH = 256;
const MAX_META_USERS_PER_NOTIFICATION = 100;

const boundedNotificationText = (value: string): string => {
  if (getUnicodeCodePointLength(value) <= MAX_NOTIFICATION_TEXT_LENGTH) return value;
  return `${truncateUnicodeCodePoints(value, MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`;
};

export interface ShareEventBase {
  entityType: ShareEntityType;
  entityId: string;
  permission?: SharePermission;
  targetUserId?: string;
  metaUserIds?: string[];
  metaOnly?: boolean;
  entityTitle?: string;
  sharedByName?: string;
  message?: string;
}

export function createShareEventPayloads(
  action: ShareEventAction,
  params: ShareEventBase,
): string[] {
  const uniqueMetaUserIds =
    params.metaUserIds === undefined ? undefined : [...new Set(params.metaUserIds)];
  const metaUserChunks: Array<string[] | undefined> = [];
  if (uniqueMetaUserIds === undefined || uniqueMetaUserIds.length === 0) {
    metaUserChunks.push(uniqueMetaUserIds);
  } else {
    for (
      let index = 0;
      index < uniqueMetaUserIds.length;
      index += MAX_META_USERS_PER_NOTIFICATION
    ) {
      metaUserChunks.push(uniqueMetaUserIds.slice(index, index + MAX_META_USERS_PER_NOTIFICATION));
    }
  }

  return metaUserChunks.map((metaUserIds, index) => {
    const isMetaOnly = params.metaOnly === true || index > 0;
    return JSON.stringify({
      type: 'share_event',
      action,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(!isMetaOnly && params.permission !== undefined && { permission: params.permission }),
      ...(index === 0 &&
        params.targetUserId !== undefined && {
          targetUserId: params.targetUserId,
        }),
      ...(metaUserIds !== undefined && { metaUserIds }),
      ...((params.metaOnly !== undefined || index > 0) && { metaOnly: isMetaOnly }),
      ...(!isMetaOnly &&
        params.message !== undefined && { message: boundedNotificationText(params.message) }),
    });
  });
}

async function fireShareEvent(
  action: ShareEventAction,
  params: ShareEventBase,
  executor: QueryExecutor = db,
): Promise<void> {
  const payloads = createShareEventPayloads(action, params);
  for (const payload of payloads) {
    await executeQuery(executor, "SELECT pg_notify('share_event', $1)", [payload]);
  }
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
      ...(params.permission !== undefined && { permission: params.permission }),
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
