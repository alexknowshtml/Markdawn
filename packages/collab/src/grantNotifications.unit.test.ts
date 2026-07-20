import type { Document, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createGrantNotifier } from './grantNotifications';

const logger = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;

describe('grant notifications', () => {
  it('publishes database-canonical grant metadata to the recipient room', async () => {
    const connection = { sendStateless: vi.fn() };
    const document = {
      getConnections: () => [connection],
    } as unknown as Document;
    const server = {
      hocuspocus: { documents: new Map([['page-meta:user-1', document]]) },
    } as unknown as Server;
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ entity_title: 'Canonical title', shared_by_name: 'Owner' }],
      }),
    } as unknown as Pool;

    await createGrantNotifier(
      server,
      pool,
      logger,
    )({
      type: 'grant_received',
      entityType: 'page',
      entityId: 'page-1',
      entityTitle: 'Untrusted title',
      sharedByName: 'Untrusted owner',
      targetUserId: 'user-1',
      permission: 'view',
    });

    expect(connection.sendStateless).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'grant_received',
        entityType: 'page',
        entityId: 'page-1',
        entityTitle: 'Canonical title',
        sharedByName: 'Owner',
        refreshViaAccessVersion: true,
      }),
    );
  });
});
