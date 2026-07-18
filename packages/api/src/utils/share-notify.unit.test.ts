import { describe, expect, it } from 'vitest';
import { createShareEventPayloads } from './share-notify';

describe('share notification payloads', () => {
  it('serializes metadata-only invalidations explicitly', () => {
    const payloads = createShareEventPayloads('recompute', {
      entityType: 'page',
      entityId: '00000000-0000-4000-8000-000000000001',
      targetUserId: '00000000-0000-4000-8000-000000000002',
      metaUserIds: ['00000000-0000-4000-8000-000000000002'],
      metaOnly: true,
    });

    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0] ?? '')).toMatchObject({
      type: 'share_event',
      action: 'recompute',
      metaOnly: true,
    });
  });

  it('chunks large recipient sets below the PostgreSQL NOTIFY payload limit', () => {
    const recipientIds = Array.from(
      { length: 250 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );

    const payloads = createShareEventPayloads('recompute', {
      entityType: 'folder',
      entityId: '00000000-0000-4000-8000-999999999999',
      metaUserIds: [...recipientIds, recipientIds[0] ?? ''],
      message: 'Hierarchy access changed',
    });

    expect(payloads).toHaveLength(3);
    expect(payloads.every((payload) => Buffer.byteLength(payload, 'utf8') < 8_000)).toBe(true);

    const deliveredIds = payloads.flatMap((payload) => {
      const parsed = JSON.parse(payload) as { metaUserIds: string[] };
      return parsed.metaUserIds;
    });
    expect(deliveredIds).toEqual(recipientIds);

    const parsedPayloads = payloads.map(
      (payload) =>
        JSON.parse(payload) as {
          metaOnly?: boolean;
          message?: string;
          permission?: string;
          targetUserId?: string;
        },
    );
    expect(parsedPayloads[0]).toMatchObject({ message: 'Hierarchy access changed' });
    expect(parsedPayloads[0]?.metaOnly).toBeUndefined();
    expect(parsedPayloads.slice(1)).toEqual([
      expect.objectContaining({ metaOnly: true }),
      expect.objectContaining({ metaOnly: true }),
    ]);
    for (const continuation of parsedPayloads.slice(1)) {
      expect(continuation).not.toHaveProperty('message');
      expect(continuation).not.toHaveProperty('permission');
      expect(continuation).not.toHaveProperty('targetUserId');
    }
  });
});
