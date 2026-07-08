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
  context?: { user?: { id: string; isAnonymous?: boolean }; permission?: string };
  readOnly?: boolean;
}) {
  return {
    context: overrides?.context ?? { user: { id: 'user-1' }, permission: 'edit' },
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

  it('updates connection.context.permission on targeted grant', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'view' },
      readOnly: true,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);

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

    expect(conn.context.permission).toBe('edit');
    expect(conn.readOnly).toBe(false);
  });

  it('updates connection.context.permission on link share update', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true }, permission: 'view' },
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

    expect(conn.context.permission).toBe('edit');
    expect(conn.readOnly).toBe(false);
  });

  it('does not revoke workspace member when link share is revoked', async () => {
    const logger = createLogger();
    const ownerConn = createConnection({
      context: { user: { id: 'owner-id' } },
    });
    const workspaceMemberConn = createConnection({
      context: { user: { id: 'workspace-member' } },
    });
    const linkOnlyConn = createConnection({
      context: { user: { id: 'link-only-user' } },
    });
    const doc = createDocument([ownerConn, workspaceMemberConn, linkOnlyConn]);
    const server = createServer(doc);
    const pool = createPool([
      privilegedEntry('owner-id', 'edit'),
      privilegedEntry('workspace-member', 'edit'),
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
    expect(linkOnlyConn.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
  });

  it('computes effective permission as max of base and link permission', async () => {
    const logger = createLogger();
    const invitedConn = createConnection({
      context: { user: { id: 'invited-user' } },
      readOnly: false,
    });
    const doc = createDocument([invitedConn]);
    const server = createServer(doc);
    const pool = createPool([privilegedEntry('invited-user', 'edit')]);

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

    // effective = max('edit', 'view') = 'edit', readOnly unchanged, no notification sent
    expect(invitedConn.readOnly).toBe(false);
    expect(invitedConn.sendStateless).not.toHaveBeenCalled();
  });

  it('sends notification when effective permission changes for link share', async () => {
    const logger = createLogger();
    const invitedConn = createConnection({
      context: { user: { id: 'invited-user' } },
      readOnly: true,
    });
    const doc = createDocument([invitedConn]);
    const server = createServer(doc);
    const pool = createPool([privilegedEntry('invited-user', 'view')]);

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
    expect(invitedConn.readOnly).toBe(false);
    expect(invitedConn.sendStateless).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"edit"'),
    );
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
    const server = createServer(doc);
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        return { rows: [{ id: 'page-1' }] };
      }
      if (sql.includes('get_effective_page_permission')) {
        return { rows: [{ permission: params?.[1] === 'direct-user' ? 'edit' : null }] };
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
    expect(directConn.sendStateless).not.toHaveBeenCalled();
  });

  it('recomputes page permissions and downgrades active editors to read-only', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
      readOnly: false,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('get_effective_page_permission')) {
        return { rows: [{ permission: 'view' }] };
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
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"action":"update"'));
    expect(conn.sendStateless).toHaveBeenCalledWith(expect.stringContaining('"permission":"view"'));
  });
});
