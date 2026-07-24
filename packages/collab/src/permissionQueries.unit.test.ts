import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  queryAnonymousPagePermissions,
  querySessionPagePermissions,
  sessionPagePermissionKey,
} from './permissionQueries';

describe('permission queries', () => {
  it('keys authenticated snapshots by session only when session validation is requested', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            page_id: 'page-1',
            user_id: 'user-1',
            session_token: 'session-1',
            permission: 'edit',
            access_revision: '9',
          },
        ],
      }),
    } as unknown as Pool;
    const candidate = { pageId: 'page-1', userId: 'user-1', sessionToken: 'session-1' };

    const states = await querySessionPagePermissions(pool, [candidate]);
    expect(states.get(sessionPagePermissionKey(candidate))).toEqual({
      permission: 'edit',
      accessRevision: '9',
    });
  });

  it('normalizes unknown anonymous permissions to denied state', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ page_id: 'page-1', permission: 'owner', access_revision: '10' }],
      }),
    } as unknown as Pool;
    await expect(queryAnonymousPagePermissions(pool, ['page-1'])).resolves.toEqual(
      new Map([['page-1', { permission: null, accessRevision: '10' }]]),
    );
  });
});
