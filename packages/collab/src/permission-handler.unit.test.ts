import type { Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { handleShareEvent } from './permission-handler';

function createLogger() {
  const fn = () => vi.fn();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    category: fn(),
    parent: null,
    getChild: fn(),
    with: fn(),
    get enabled() {
      return true;
    },
    log: fn(),
    trace: fn(),
  } as unknown as Logger;
}

function createConnection(overrides?: {
  context?: { user?: { id: string; isAnonymous?: boolean } };
  readOnly?: boolean;
}) {
  return {
    context: overrides?.context ?? { user: { id: 'user-1' } },
    readOnly: overrides?.readOnly ?? false,
    sendStateless: vi.fn(),
    close: vi.fn(),
  };
}

function createDocument(connections: ReturnType<typeof createConnection>[]) {
  return {
    getConnections: () => connections,
  };
}

function createServer(doc: ReturnType<typeof createDocument> | undefined) {
  return {
    hocuspocus: {
      documents: {
        get: vi.fn().mockReturnValue(doc),
      },
    },
    configure: vi.fn(),
    destroy: vi.fn(),
    listen: vi.fn(),
  } as unknown as Server;
}

function createPool(entries: Array<{ user_id: string; permission: string }> = []) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: entries,
    }),
  } as unknown as Pool;
}

function privilegedEntry(userId: string, permission: string = 'view') {
  return { user_id: userId, permission };
}

describe('handleShareEvent', () => {
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
    // user-1 has a direct invite — should NOT be affected by link share changes
    const authConn = createConnection({
      context: { user: { id: 'user-1' } },
    });
    const doc = createDocument([anonConn, authConn]);
    const server = createServer(doc);
    const pool = createPool([privilegedEntry('user-1', 'view')]);

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

  it('revokes authenticated link-only connections when targetUserId is undefined', async () => {
    const logger = createLogger();
    // link-only user (no direct invite, no folder access)
    const linkUserConn = createConnection({
      context: { user: { id: 'link-user-1' } },
    });
    // user with a direct invite — should be skipped
    const invitedConn = createConnection({
      context: { user: { id: 'invited-user' } },
    });
    const doc = createDocument([linkUserConn, invitedConn]);
    const server = createServer(doc);
    const pool = createPool([privilegedEntry('invited-user', 'view')]);

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

    expect(linkUserConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
    expect(linkUserConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"action":"revoke"'),
    );
    expect(invitedConn.close).not.toHaveBeenCalled();
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

    // Pool not needed — targeted events skip the invite query
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
        targetUserId: 'user-target',
      },
      undefined,
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
    const pool = createPool();

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
    const pool = createPool();

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
    const pool = createPool();

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

    // Pool not needed — targeted events skip the invite query
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
      undefined,
      logger,
    );

    expect(conn.readOnly).toBe(false);
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"action":"grant"'));
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

  it('skips unknown permission values', async () => {
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

    expect(conn.readOnly).toBe(false);
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  it('updates authenticated link-only connections when link permission changes', async () => {
    const logger = createLogger();
    // link-only user (no direct invite) — should get updated
    const linkUserConn = createConnection({
      context: { user: { id: 'link-user' } },
      readOnly: false,
    });
    // invited user — also gets updated (effective permission is max(view, view) = view)
    const invitedConn = createConnection({
      context: { user: { id: 'invited-user' } },
      readOnly: false,
    });
    const doc = createDocument([linkUserConn, invitedConn]);
    const server = createServer(doc);
    const pool = createPool([privilegedEntry('invited-user', 'view')]);

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
    expect(linkUserConn.readOnly).toBe(true);
    expect(linkUserConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"view"'),
    );
    expect(invitedConn.readOnly).toBe(true);
    expect(invitedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"view"'),
    );
  });

  it('does not revoke page owner when link share changes', async () => {
    const logger = createLogger();
    const ownerConn = createConnection({
      context: { user: { id: 'owner-id' } },
    });
    // link-only user (no invite, not owner) — should be revoked
    const linkUserConn = createConnection({
      context: { user: { id: 'link-user' } },
    });
    const doc = createDocument([ownerConn, linkUserConn]);
    const server = createServer(doc);
    // pool returns the owner as privileged (from the UNION with pages.created_by)
    const pool = createPool([privilegedEntry('owner-id', 'edit')]);

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
    expect(linkUserConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
  });

  it('does not affect authenticated user when targetUserId does not match', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-other' } },
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);

    // Pool not needed — targeted events skip the invite query
    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'revoke',
        entityType: 'page',
        entityId: 'page-1',
        targetUserId: 'user-target',
      },
      undefined,
      logger,
    );

    expect(conn.close).not.toHaveBeenCalled();
  });
});
