import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { handleShareEvent, handleWorkspaceEvent } from './permission-handler';
import {
  ACTIVE_PAGE_ID,
  createConnection,
  createDocument,
  createLogger,
  createPool,
  createServer,
  createServerWithDocuments,
  OTHER_ACTIVE_PAGE_ID,
  permissionEntry,
} from './permissionHandlerTestUtils';

describe('handleShareEvent', () => {
  it('handles metadata-only provenance events without page or folder permission fanout', async () => {
    const pageConnection = createConnection({
      context: { user: { id: 'recipient' }, permission: 'view', accessRevision: '1' },
      readOnly: true,
    });
    const pageDocument = createDocument([pageConnection]);
    const metaDocument = createDocument([]);
    const server = createServerWithDocuments(
      new Map([
        ['page-1', pageDocument],
        ['page-meta:recipient', metaDocument],
      ]),
    );
    const pool = { query: vi.fn() } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'folder',
        entityId: 'folder-1',
        targetUserId: 'recipient',
        metaUserIds: ['recipient'],
        metaOnly: true,
      },
      pool,
      createLogger(),
    );

    expect(metaDocument.getMap('accessVersion').get('access')).toBe(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pageConnection.sendStateless).not.toHaveBeenCalled();
    expect(pageConnection.close).not.toHaveBeenCalled();
    expect(pageConnection.readOnly).toBe(true);
  });

  it('suppresses an in-flight stale message and delivers the latest canonical targeted update', async () => {
    const targetConnection = createConnection({
      context: { user: { id: 'target-user' }, permission: 'view', accessRevision: '1' },
      readOnly: true,
    });
    const otherConnection = createConnection({
      context: { user: { id: 'other-user' }, permission: 'view', accessRevision: '1' },
      readOnly: true,
    });
    const server = createServerWithDocuments(
      new Map([[ACTIVE_PAGE_ID, createDocument([targetConnection, otherConnection])]]),
    );
    let releaseFirstQuery: (() => void) | undefined;
    const firstQueryBarrier = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    let markFirstQueryStarted: (() => void) | undefined;
    const firstQueryStarted = new Promise<void>((resolve) => {
      markFirstQueryStarted = resolve;
    });
    let permissionQueryCount = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('get_effective_page_permission')) return { rows: [] };
      permissionQueryCount++;
      if (permissionQueryCount === 1) {
        markFirstQueryStarted?.();
        await firstQueryBarrier;
      }
      const userIds = params?.[1] as string[];
      const pageIds = params?.[0] as string[];
      return {
        rows: userIds.map((userId, index) => ({
          page_id: pageIds[index],
          user_id: userId,
          permission: 'edit',
          access_revision: String(100 + permissionQueryCount),
        })),
      };
    });
    const pool = { query } as unknown as Pool;

    const staleEvent = handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'grant',
        entityType: 'page',
        entityId: ACTIVE_PAGE_ID,
        targetUserId: 'target-user',
        permission: 'view',
        message: 'View access granted',
      },
      pool,
      createLogger(),
    );
    await firstQueryStarted;
    releaseFirstQuery?.();
    await staleEvent;
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: ACTIVE_PAGE_ID,
        targetUserId: 'target-user',
        permission: 'edit',
        message: 'Edit access granted',
      },
      pool,
      createLogger(),
    );

    const statelessMessages = targetConnection.sendStateless.mock.calls.map(
      ([message]) => message as string,
    );
    expect(statelessMessages.some((message) => message.includes('View access granted'))).toBe(
      false,
    );
    expect(statelessMessages).toContain(
      JSON.stringify({
        type: 'share_event',
        action: 'update',
        permission: 'edit',
        message: 'Edit access granted',
      }),
    );
    expect(targetConnection.readOnly).toBe(false);
    expect(otherConnection.sendStateless).not.toHaveBeenCalled();
    expect(otherConnection.readOnly).toBe(true);
    for (const [, params] of query.mock.calls) {
      expect(params?.[1]).toEqual(['target-user']);
    }
  });

  it('does not revalidate an anonymous connection that reuses a targeted account ID', async () => {
    const accountConnection = createConnection({
      context: { user: { id: 'target-user' }, permission: 'view', accessRevision: '1' },
      readOnly: true,
    });
    const anonymousConnection = createConnection({
      context: {
        user: { id: 'target-user', isAnonymous: true },
        permission: 'view',
        accessRevision: '1',
      },
      readOnly: true,
    });
    const server = createServerWithDocuments(
      new Map([[ACTIVE_PAGE_ID, createDocument([accountConnection, anonymousConnection])]]),
    );
    const pool = createPool([permissionEntry('target-user', 'edit')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: ACTIVE_PAGE_ID,
        targetUserId: 'target-user',
        permission: 'edit',
      },
      pool,
      createLogger(),
    );

    expect(accountConnection.context.permission).toBe('edit');
    expect(anonymousConnection.context.permission).toBe('view');
    expect(anonymousConnection.sendStateless).not.toHaveBeenCalled();
    expect(anonymousConnection.close).not.toHaveBeenCalled();
  });

  it('keeps an equal-revision downgrade when an older permission query arrives late', async () => {
    const connection = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit', accessRevision: '100' },
      readOnly: false,
    });
    const server = createServerWithDocuments(
      new Map([[ACTIVE_PAGE_ID, createDocument([connection])]]),
    );
    let releaseOlderQuery: (() => void) | undefined;
    const olderQueryBarrier = new Promise<void>((resolve) => {
      releaseOlderQuery = resolve;
    });
    let markOlderQueryStarted: (() => void) | undefined;
    const olderQueryStarted = new Promise<void>((resolve) => {
      markOlderQueryStarted = resolve;
    });
    let permissionQueryCount = 0;
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (!sql.includes('get_effective_page_permission')) return { rows: [] };
        permissionQueryCount++;
        const thisQuery = permissionQueryCount;
        if (thisQuery === 1) {
          markOlderQueryStarted?.();
          await olderQueryBarrier;
        }
        const userIds = params?.[1] as string[];
        const pageIds = params?.[0] as string[];
        return {
          rows: userIds.map((userId, index) => ({
            page_id: pageIds[index],
            user_id: userId,
            permission: thisQuery === 1 ? 'edit' : 'view',
            access_revision: '100',
          })),
        };
      }),
    } as unknown as Pool;

    const delayedOlderQuery = handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'page',
        entityId: ACTIVE_PAGE_ID,
        targetUserId: 'user-1',
      },
      pool,
      createLogger(),
    );
    await olderQueryStarted;
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'page',
        entityId: ACTIVE_PAGE_ID,
        targetUserId: 'user-1',
      },
      pool,
      createLogger(),
    );
    releaseOlderQuery?.();
    await delayedOlderQuery;

    expect(connection.context.permission).toBe('view');
    expect(connection.context.accessRevision).toBe('100');
    expect(connection.readOnly).toBe(true);
    const permissionSnapshots = connection.sendStateless.mock.calls
      .map(([message]) => JSON.parse(message as string) as { type: string; permission?: string })
      .filter((message) => message.type === 'permission_snapshot');
    expect(permissionSnapshots.at(-1)?.permission).toBe('view');
  });

  it('does nothing when no active document exists', async () => {
    const logger = createLogger();
    const server = createServer(undefined);
    const pool = createPool();

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no active document for page page-1'),
    );
  });

  it('revokes anonymous connections when targetUserId is undefined', async () => {
    const logger = createLogger();
    const anonConn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
    });
    // user-1 has a direct account grant and retains access.
    const authConn = createConnection({
      context: { user: { id: 'user-1' } },
    });
    const doc = createDocument([anonConn, authConn]);
    const server = createServer(doc);
    const pool = createPool([permissionEntry('user-1', 'view')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(anonConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
    expect(anonConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"action":"revoke"'),
    );
    expect(authConn.close).not.toHaveBeenCalled();
  });

  it('revokes authenticated public-only connections when targetUserId is undefined', async () => {
    const logger = createLogger();
    // Public-only user (no direct grant or folder access).
    const publicUserConn = createConnection({
      context: { user: { id: 'public-user-1' } },
    });
    // A user with a View account grant must fall back to read-only access.
    const grantedConn = createConnection({
      context: { user: { id: 'granted-user' }, permission: 'edit' },
    });
    const doc = createDocument([publicUserConn, grantedConn]);
    const server = createServer(doc);
    const pool = createPool([permissionEntry('granted-user', 'view')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(publicUserConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
    expect(publicUserConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"action":"revoke"'),
    );
    expect(grantedConn.close).not.toHaveBeenCalled();
    expect(grantedConn.readOnly).toBe(true);
    expect(grantedConn.context.permission).toBe('view');
    expect(grantedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"action":"update"'),
    );
  });

  it('revokes a specific authenticated user when targetUserId is set', async () => {
    const logger = createLogger();
    const targetConn = createConnection({
      context: { user: { id: 'user-target' } },
    });
    const otherConn = createConnection({
      context: { user: { id: 'user-other' } },
    });
    const doc = createDocument([targetConn, otherConn]);
    const server = createServer(doc);

    const pool = createPool();
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
        targetUserId: 'user-target',
      },
      pool,
      logger,
    );

    expect(targetConn.close).toHaveBeenCalled();
    expect(otherConn.close).not.toHaveBeenCalled();
  });

  it('sets readOnly when permission changes to view', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
      readOnly: false,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool([], { anonymousPermission: 'view' });

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'view',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"permission":"view"'));
  });

  it('clears readOnly when permission changes to edit', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool([], { anonymousPermission: 'edit' });

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'edit',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(false);
  });

  it('passes admin permission through as-is', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool([], { anonymousPermission: 'admin' });

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'admin',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(false);
    expect(conn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"admin"'),
    );
  });

  it('handles grant action like update', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' } },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);

    const pool = createPool([], { defaultPermission: 'edit' });
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'grant',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'edit',
        targetUserId: 'user-1',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(false);
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"action":"update"'));
  });

  it('skips connections with no user context', async () => {
    const logger = createLogger();
    const conn = createConnection({ context: {} });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool();

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(conn.close).not.toHaveBeenCalled();
  });

  it('uses canonical permission state instead of an invalid advertised permission', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool();

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'invalid' as never,
      },
      pool,
      logger,
    );

    expect(conn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
  });

  it('updates authenticated connections when public permission changes', async () => {
    const logger = createLogger();
    // Public-only user (no direct grant) should be updated.
    const publicUserConn = createConnection({
      context: { user: { id: 'public-user' } },
      readOnly: false,
    });
    // An account-granted user is also updated (effective max is View).
    const grantedConn = createConnection({
      context: { user: { id: 'granted-user' } },
      readOnly: false,
    });
    const doc = createDocument([publicUserConn, grantedConn]);
    const server = createServer(doc);
    const pool = createPool([
      permissionEntry('public-user', 'view'),
      permissionEntry('granted-user', 'view'),
    ]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'view',
      },
      pool,
      logger,
    );

    // Both connections get readOnly=true because effective permission is 'view'
    expect(publicUserConn.readOnly).toBe(true);
    expect(publicUserConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"view"'),
    );
    expect(grantedConn.readOnly).toBe(true);
    expect(grantedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"view"'),
    );
  });

  it('does not revoke the page owner when public access changes', async () => {
    const logger = createLogger();
    const ownerConn = createConnection({
      context: { user: { id: 'owner-id' } },
    });
    // Public-only user (no account grant and not owner) should be revoked.
    const publicUserConn = createConnection({
      context: { user: { id: 'public-user' } },
    });
    const doc = createDocument([ownerConn, publicUserConn]);
    const server = createServer(doc);
    // The effective-permission query returns the owner's independent access.
    const pool = createPool([permissionEntry('owner-id', 'edit')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(ownerConn.close).not.toHaveBeenCalled();
    expect(publicUserConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
  });

  it('does not affect authenticated user when targetUserId does not match', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-other' } },
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);

    const pool = createPool();
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
        targetUserId: 'user-target',
      },
      pool,
      logger,
    );

    expect(conn.close).not.toHaveBeenCalled();
  });

  it('updates connection.context.permission on targeted grant', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'view' },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool([], { defaultPermission: 'edit' });

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'grant',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'edit',
        targetUserId: 'user-1',
      },
      pool,
      logger,
    );

    expect(conn.context.permission).toBe('edit');
    expect(conn.readOnly).toBe(false);
  });

  it('updates connection.context.permission on public-access updates', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true }, permission: 'view' },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const pool = createPool([], { anonymousPermission: 'edit' });

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'edit',
      },
      pool,
      logger,
    );

    expect(conn.context.permission).toBe('edit');
    expect(conn.readOnly).toBe(false);
  });

  it('does not revoke a workspace member when public access is revoked', async () => {
    const logger = createLogger();
    const ownerConn = createConnection({
      context: { user: { id: 'owner-id' } },
    });
    const workspaceMemberConn = createConnection({
      context: { user: { id: 'workspace-member' } },
    });
    const publicOnlyConn = createConnection({
      context: { user: { id: 'public-only-user' } },
    });
    const doc = createDocument([ownerConn, workspaceMemberConn, publicOnlyConn]);
    const server = createServer(doc);
    const pool = createPool([
      permissionEntry('owner-id', 'edit'),
      permissionEntry('workspace-member', 'edit'),
    ]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(ownerConn.close).not.toHaveBeenCalled();
    expect(workspaceMemberConn.close).not.toHaveBeenCalled();
    expect(publicOnlyConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
  });

  it('preserves a stronger account permission when public permission is weaker', async () => {
    const logger = createLogger();
    const grantedConn = createConnection({
      context: { user: { id: 'granted-user' }, permission: 'edit' },
      readOnly: false,
    });
    const doc = createDocument([grantedConn]);
    const server = createServerWithDocuments(new Map([['page-1', doc]]));
    const pool = createPool([permissionEntry('granted-user', 'edit')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'view',
      },
      pool,
      logger,
    );

    // The authoritative snapshot is sent even when the compatibility event is unnecessary.
    expect(grantedConn.readOnly).toBe(false);
    expect(grantedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"type":"permission_snapshot"'),
    );
    expect(grantedConn.sendStateless).not.toHaveBeenCalledWith(
      expect.stringContaining('"action":"update"'),
    );
  });

  it('sends a notification when public access changes the effective permission', async () => {
    const logger = createLogger();
    const grantedConn = createConnection({
      context: { user: { id: 'granted-user' } },
      readOnly: true,
    });
    const doc = createDocument([grantedConn]);
    const server = createServer(doc);
    const pool = createPool([permissionEntry('granted-user', 'edit')]);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'edit',
      },
      pool,
      logger,
    );

    // effective = max('view', 'edit') = 'edit', readOnly changes from true → false
    expect(grantedConn.readOnly).toBe(false);
    expect(grantedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"edit"'),
    );
  });

  it('recomputes folder share grants instead of downgrading stronger direct page access', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
      readOnly: false,
    });
    const otherConn = createConnection({
      context: { user: { id: 'user-2' }, permission: 'view' },
      readOnly: true,
    });
    const doc = createDocument([conn, otherConn]);
    const server = createServerWithDocuments(new Map([[ACTIVE_PAGE_ID, doc]]));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        return { rows: [{ id: ACTIVE_PAGE_ID }] };
      }
      if (sql.includes('get_effective_page_permission')) {
        return {
          rows: [
            {
              page_id: ACTIVE_PAGE_ID,
              user_id: 'user-1',
              permission: 'edit',
              access_revision: '101',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'grant',
        entityType: 'folder',
        entityId: 'folder-1',
        permission: 'view',
        targetUserId: 'user-1',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(false);
    expect(conn.context.permission).toBe('edit');
    expect(conn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"type":"permission_snapshot"'),
    );
    expect(conn.sendStateless).not.toHaveBeenCalledWith(
      expect.stringContaining('"action":"update"'),
    );
    expect(otherConn.sendStateless).not.toHaveBeenCalled();
    expect(otherConn.readOnly).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('p.id = ANY($2::uuid[])'), [
      'folder-1',
      [ACTIVE_PAGE_ID],
    ]);
  });

  it('recomputes folder inheritance changes and revokes users who lost access', async () => {
    const logger = createLogger();
    const inheritedConn = createConnection({
      context: { user: { id: 'inherited-user' }, permission: 'edit' },
      readOnly: false,
    });
    const directConn = createConnection({
      context: { user: { id: 'direct-user' }, permission: 'edit' },
      readOnly: false,
    });
    const doc = createDocument([inheritedConn, directConn]);
    const server = createServerWithDocuments(new Map([[ACTIVE_PAGE_ID, doc]]));
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        return { rows: [{ id: ACTIVE_PAGE_ID }] };
      }
      if (sql.includes('get_effective_page_permission')) {
        const userIds = params?.[1] as string[];
        const pageIds = params?.[0] as string[];
        return {
          rows: userIds.map((userId, index) => ({
            page_id: pageIds[index],
            user_id: userId,
            permission: userId === 'direct-user' ? 'edit' : null,
            access_revision: '102',
          })),
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'folder',
        entityId: 'folder-1',
        message: 'Restricted child stopped inheriting access',
      },
      pool,
      logger,
    );

    expect(inheritedConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
    expect(inheritedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"action":"revoke"'),
    );
    expect(directConn.close).not.toHaveBeenCalled();
    expect(directConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"type":"permission_snapshot"'),
    );
    expect(directConn.sendStateless).not.toHaveBeenCalledWith(
      expect.stringContaining('"action":"update"'),
    );
  });

  it('fails closed only for affected user connections when a folder lookup fails', async () => {
    const logger = createLogger();
    const affectedConn = createConnection({
      context: { user: { id: 'target-user' }, permission: 'edit' },
    });
    const unrelatedConn = createConnection({
      context: { user: { id: 'target-user' }, permission: 'edit' },
    });
    const otherUserConn = createConnection({
      context: { user: { id: 'other-user' }, permission: 'edit' },
    });
    const server = createServerWithDocuments(
      new Map([
        [ACTIVE_PAGE_ID, createDocument([affectedConn, otherUserConn])],
        [OTHER_ACTIVE_PAGE_ID, createDocument([unrelatedConn])],
      ]),
    );
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        throw new Error('folder lookup failed');
      }
      if (sql.includes('get_effective_page_permission')) {
        const pageIds = params?.[0] as string[];
        const userIds = params?.[1] as string[];
        return {
          rows: userIds.map((userId, index) => ({
            page_id: pageIds[index],
            user_id: userId,
            permission: pageIds[index] === ACTIVE_PAGE_ID ? null : 'edit',
            access_revision: '100',
          })),
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'folder',
        entityId: 'folder-1',
        targetUserId: 'target-user',
      },
      pool,
      logger,
    );

    expect(affectedConn.close).toHaveBeenCalled();
    expect(unrelatedConn.close).not.toHaveBeenCalled();
    expect(otherUserConn.close).not.toHaveBeenCalled();
  });

  it('notifies the recipient meta room even when no folder descendants are open', async () => {
    const logger = createLogger();
    const metaConnection = createConnection({
      context: { user: { id: 'user-1' }, permission: 'view' },
    });
    const ownerMetaConnection = createConnection({
      context: { user: { id: 'owner-1' }, permission: 'admin' },
    });
    const recipientMetaDocument = createDocument([metaConnection]);
    const ownerMetaDocument = createDocument([ownerMetaConnection]);
    const server = createServerWithDocuments(
      new Map([
        ['page-meta:user-1', recipientMetaDocument],
        ['page-meta:owner-1', ownerMetaDocument],
      ]),
    );
    const pool = { query: vi.fn() } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'folder',
        entityId: 'folder-1',
        targetUserId: 'user-1',
        metaUserIds: ['owner-1'],
      },
      pool,
      logger,
    );

    expect(recipientMetaDocument.getMap().get('access')).toBe(1);
    expect(ownerMetaDocument.getMap().get('access')).toBe(1);
    expect(metaConnection.sendStateless).not.toHaveBeenCalled();
    expect(ownerMetaConnection.sendStateless).not.toHaveBeenCalled();
  });

  it('notifies the owner and member meta rooms when workspace membership changes', async () => {
    const logger = createLogger();
    const memberMetaConnection = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const ownerMetaConnection = createConnection({
      context: { user: { id: 'workspace-owner' }, permission: 'admin' },
    });
    const memberMetaDocument = createDocument([memberMetaConnection]);
    const ownerMetaDocument = createDocument([ownerMetaConnection]);
    const server = createServerWithDocuments(
      new Map([
        ['page-meta:member-1', memberMetaDocument],
        ['page-meta:workspace-owner', ownerMetaDocument],
      ]),
    );
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;

    await handleWorkspaceEvent(
      server,
      {
        type: 'workspace_event',
        action: 'role_changed',
        ownerId: 'workspace-owner',
        memberId: 'member-1',
      },
      pool,
      logger,
    );

    expect(memberMetaDocument.getMap().get('access')).toBe(1);
    expect(ownerMetaDocument.getMap().get('access')).toBe(1);
    const compatibilityMessage = JSON.stringify({
      type: 'workspace_membership_event',
      action: 'role_changed',
      ownerId: 'workspace-owner',
      refreshViaAccessVersion: true,
    });
    expect(memberMetaConnection.sendStateless).toHaveBeenCalledWith(compatibilityMessage);
    expect(ownerMetaConnection.sendStateless).toHaveBeenCalledWith(compatibilityMessage);
  });

  it('batches workspace permission checks across active pages', async () => {
    const logger = createLogger();
    const firstConnection = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const secondConnection = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const server = createServerWithDocuments(
      new Map([
        ['page-1', createDocument([firstConnection])],
        ['page-2', createDocument([secondConnection])],
      ]),
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('p.id = ANY($2::uuid[])')) {
        return { rows: [{ id: 'page-1' }, { id: 'page-2' }] };
      }
      if (sql.includes('WITH requested_users AS')) {
        return {
          rows: [
            {
              page_id: 'page-1',
              user_id: 'member-1',
              permission: 'view',
              access_revision: '100',
            },
            {
              page_id: 'page-2',
              user_id: 'member-1',
              permission: 'edit',
              access_revision: '100',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleWorkspaceEvent(
      server,
      {
        type: 'workspace_event',
        action: 'role_changed',
        ownerId: 'workspace-owner',
        memberId: 'member-1',
      },
      pool,
      logger,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(firstConnection.readOnly).toBe(true);
    expect(secondConnection.readOnly).toBe(false);
  });

  it('fails closed only for affected workspace connections when owner lookup fails', async () => {
    const logger = createLogger();
    const affectedConn = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const unrelatedConn = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const server = createServerWithDocuments(
      new Map([
        ['affected-page', createDocument([affectedConn])],
        ['unrelated-page', createDocument([unrelatedConn])],
      ]),
    );
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('COALESCE(get_root_folder_owner(p.parent_id), p.created_by) = $1')) {
        throw new Error('workspace lookup failed');
      }
      if (sql.includes('get_effective_page_permission')) {
        const pageIds = params?.[0] as string[];
        const userIds = params?.[1] as string[];
        return {
          rows: userIds.map((userId, index) => ({
            page_id: pageIds[index],
            user_id: userId,
            permission: pageIds[index] === 'affected-page' ? null : 'edit',
            access_revision: '100',
          })),
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleWorkspaceEvent(
      server,
      {
        type: 'workspace_event',
        action: 'member_removed',
        ownerId: 'workspace-owner',
        memberId: 'member-1',
      },
      pool,
      logger,
    );

    expect(affectedConn.close).toHaveBeenCalled();
    expect(unrelatedConn.close).not.toHaveBeenCalled();
  });

  it('batches permission recomputation for all active page connections', async () => {
    const logger = createLogger();
    const connections = [
      createConnection({ context: { user: { id: 'user-1' }, permission: 'edit' } }),
      createConnection({ context: { user: { id: 'user-2' }, permission: 'view' }, readOnly: true }),
      createConnection({ context: { user: { id: 'user-1' }, permission: 'edit' } }),
      createConnection({
        context: { user: { id: 'anon-1', isAnonymous: true }, permission: 'edit' },
      }),
      createConnection({
        context: { user: { id: 'anon-2', isAnonymous: true }, permission: 'edit' },
      }),
    ];
    const server = createServer(createDocument(connections));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('requested_users')) {
        return {
          rows: [
            { user_id: 'user-1', permission: 'edit' },
            { user_id: 'user-2', permission: 'view' },
          ],
        };
      }
      if (sql.includes('get_public_page_permission')) {
        return { rows: [{ permission: 'edit', access_revision: '100' }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('requested_users')),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('get_public_page_permission')),
    ).toHaveLength(1);
  });

  it('does not report a recomputation query failure as an access revoke', async () => {
    const logger = createLogger();
    const connection = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
    });
    const server = createServer(createDocument([connection]));
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(connection.close).toHaveBeenCalledWith({
      code: 4500,
      reason: 'Permission verification failed',
    });
    expect(connection.sendStateless).not.toHaveBeenCalled();
  });

  it('recomputes page permissions and downgrades active editors to read-only', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
      readOnly: false,
    });
    const secondTab = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
      readOnly: false,
    });
    const metaConnection = createConnection({
      context: { user: { id: 'user-1' }, permission: 'view' },
      readOnly: true,
    });
    const doc = createDocument([conn, secondTab]);
    const metaDocument = createDocument([metaConnection]);
    const server = createServerWithDocuments(
      new Map([
        ['page-1', doc],
        ['page-meta:user-1', metaDocument],
      ]),
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('get_effective_page_permission')) {
        return {
          rows: [
            {
              page_id: 'page-1',
              user_id: 'user-1',
              permission: 'view',
              access_revision: '100',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'recompute',
        entityType: 'page',
        entityId: 'page-1',
      },
      pool,
      logger,
    );

    expect(conn.readOnly).toBe(true);
    expect(conn.context.permission).toBe('view');
    expect(secondTab.readOnly).toBe(true);
    expect(secondTab.context.permission).toBe('view');
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"action":"update"'));
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"permission":"view"'));
    expect(metaDocument.getMap().get('access')).toBe(1);
    expect(metaConnection.sendStateless).not.toHaveBeenCalled();
  });
});
