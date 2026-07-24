import { describe, expect, it } from 'vitest';
import {
  parseGrantReceivedPayload,
  parseNotificationJson,
  parseShareEventPayload,
  parseWorkspaceEventPayload,
} from './notificationPayloads';

describe('notification payload parsing', () => {
  const PAGE_ID = '00000000-0000-4000-8000-000000000001';
  const USER_ID = '00000000-0000-4000-8000-000000000002';
  const OTHER_USER_ID = '00000000-0000-4000-8000-000000000003';

  it('rejects malformed JSON and non-object payloads', () => {
    expect(parseNotificationJson('{')).toBeNull();
    expect(parseNotificationJson('[]')).toBeNull();
  });

  it('accepts complete share events and rejects invalid permission shapes', () => {
    const payload = parseNotificationJson(
      JSON.stringify({
        type: 'share_event',
        action: 'grant',
        entityType: 'page',
        entityId: PAGE_ID,
        permission: 'edit',
        metaUserIds: [USER_ID],
      }),
    );
    expect(payload && parseShareEventPayload(payload)).toMatchObject({
      action: 'grant',
      permission: 'edit',
      metaUserIds: [USER_ID],
    });
    expect(
      parseShareEventPayload({
        type: 'share_event',
        action: 'grant',
        entityType: 'page',
        entityId: PAGE_ID,
        permission: 'owner',
      }),
    ).toBeNull();
  });

  it('requires complete grant and workspace identities', () => {
    expect(
      parseGrantReceivedPayload({
        type: 'grant_received',
        entityType: 'page',
        entityId: PAGE_ID,
        entityTitle: 'Page',
        sharedByName: 'Owner',
        targetUserId: USER_ID,
        permission: 'view',
      }),
    ).not.toBeNull();
    expect(
      parseGrantReceivedPayload({
        type: 'grant_received',
        entityType: 'page',
        entityId: PAGE_ID,
        entityTitle: 'Page',
        sharedByName: 'Owner',
        targetUserId: USER_ID,
      }),
    ).toBeNull();
    expect(parseGrantReceivedPayload({ type: 'grant_received', entityId: PAGE_ID })).toBeNull();
    expect(
      parseWorkspaceEventPayload({
        type: 'workspace_event',
        action: 'role_changed',
        ownerId: USER_ID,
        memberId: OTHER_USER_ID,
      }),
    ).not.toBeNull();
  });
});
