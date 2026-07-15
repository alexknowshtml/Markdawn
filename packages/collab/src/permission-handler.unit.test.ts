import type { Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  handleShareEvent,
  handleWorkspaceEvent,
  revalidateActivePageConnections,
} from './permission-handler';

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

function createServerWithDocuments(
  documents: Map<string, ReturnType<typeof createDocument>>,
): Server {
  return {
    hocuspocus: {
      documents,
    },
    configure: vi.fn(),
    destroy: vi.fn(),
    listen: vi.fn(),
  } as unknown as Server;
}

function createPool(
  entries: Array<{ user_id: string; permission: string }> = [],
  options?: { anonymousPermission?: string | null; defaultPermission?: string | null },
) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('get_page_base_permissions')) {
        return { rows: entries };
      }
      if (sql.includes('get_effective_page_permission')) {
        const requestedUsers = params?.[1];
        if (Array.isArray(requestedUsers)) {
          return {
            rows: requestedUsers.map((userId) => {
              const entry = entries.find((item) => item.user_id === userId);
              return {
                user_id: userId,
                permission: entry?.permission ?? options?.defaultPermission ?? null,
              };
            }),
          };
        }
        const entry = entries.find((item) => item.user_id === requestedUsers);
        return { rows: [{ permission: entry?.permission ?? options?.defaultPermission ?? null }] };
      }
      if (sql.includes('WITH page_parent')) {
        return {
          rows: options?.anonymousPermission ? [{ permission: options.anonymousPermission }] : [],
        };
      }
      return { rows: entries };
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

  it('skips unknown permission values when no database pool is available', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'anon-1', isAnonymous: true } },
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);

    await handleShareEvent(
      server,
      {
        type: 'share_event',
        action: 'update',
        entityType: 'page',
        entityId: 'page-1',
        permission: 'invalid' as never,
      },
      undefined,
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
    const pool = createPool([
      privilegedEntry('link-user', 'view'),
      privilegedEntry('invited-user', 'view'),
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
      context: { user: { id: 'invited-user' }, permission: 'edit' },
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
    const pool = createPool([privilegedEntry('invited-user', 'edit')]);

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

  it('recomputes folder share grants instead of downgrading stronger direct page access', async () => {
    const logger = createLogger();
    const conn = createConnection({
      context: { user: { id: 'user-1' }, permission: 'edit' },
      readOnly: false,
    });
    const doc = createDocument([conn]);
    const server = createServer(doc);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        return { rows: [{ id: 'page-1' }] };
      }
      if (sql.includes('get_effective_page_permission')) {
        return { rows: [{ user_id: 'user-1', permission: 'edit' }] };
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
    expect(conn.sendStateless).not.toHaveBeenCalled();
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
        const userIds = params?.[1] as string[];
        return {
          rows: userIds.map((userId) => ({
            user_id: userId,
            permission: userId === 'direct-user' ? 'edit' : null,
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
    expect(directConn.sendStateless).not.toHaveBeenCalled();
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
        ['affected-page', createDocument([affectedConn, otherUserConn])],
        ['unrelated-page', createDocument([unrelatedConn])],
      ]),
    );
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT p.id FROM pages p')) {
        throw new Error('folder lookup failed');
      }
      if (sql.includes('get_effective_page_permission')) {
        const userIds = params?.[1] as string[];
        return {
          rows: userIds.map((userId) => ({
            user_id: userId,
            permission: params?.[0] === 'affected-page' ? null : 'edit',
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

  it('notifies the active meta room when workspace membership changes', async () => {
    const logger = createLogger();
    const metaConnection = createConnection({
      context: { user: { id: 'member-1' }, permission: 'edit' },
    });
    const server = createServerWithDocuments(
      new Map([['page-meta:member-1', createDocument([metaConnection])]]),
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

    expect(metaConnection.sendStateless).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'workspace_membership_event',
        action: 'role_changed',
        ownerId: 'workspace-owner',
      }),
    );
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
      if (sql.includes('WITH requested_pages AS')) {
        return {
          rows: [
            { page_id: 'page-1', permission: 'view' },
            { page_id: 'page-2', permission: 'edit' },
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
        const userIds = params?.[1] as string[];
        return {
          rows: userIds.map((userId) => ({
            user_id: userId,
            permission: params?.[0] === 'affected-page' ? null : 'edit',
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
      if (sql.includes('WITH page_parent')) {
        return { rows: [{ permission: 'edit' }] };
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
      query.mock.calls.filter(([sql]) => String(sql).includes('WITH page_parent')),
    ).toHaveLength(1);
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
        return { rows: [{ user_id: 'user-1', permission: 'view' }] };
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

describe('revalidateActivePageConnections', () => {
  it('revokes expired access with batched authenticated and anonymous lookups', async () => {
    const logger = createLogger();
    const pageId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    const expiredConnection = createConnection({
      context: { user: { id: userId }, permission: 'view' },
      readOnly: true,
    });
    const anonymousConnection = createConnection({
      context: { user: { id: 'anonymous-1', isAnonymous: true }, permission: 'edit' },
    });
    const server = createServerWithDocuments(
      new Map([[pageId, createDocument([expiredConnection, anonymousConnection])]]),
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('unnest($1::uuid[], $2::uuid[])')) {
        return { rows: [{ page_id: pageId, user_id: userId, permission: null }] };
      }
      if (sql.includes('with page_parent')) {
        return { rows: [{ page_id: pageId, permission: 'edit' }] };
      }
      return { rows: [] };
    });

    const affected = await revalidateActivePageConnections(
      server,
      { query } as unknown as Pool,
      logger,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(affected).toBe(1);
    expect(expiredConnection.close).toHaveBeenCalledWith({
      code: 4401,
      reason: 'Access revoked',
    });
    expect(anonymousConnection.close).not.toHaveBeenCalled();
  });

  it('fails closed with a verification error when a batch query fails', async () => {
    const logger = createLogger();
    const pageId = '00000000-0000-4000-8000-000000000003';
    const userId = '00000000-0000-4000-8000-000000000004';
    const connection = createConnection({
      context: { user: { id: userId }, permission: 'edit' },
    });
    const server = createServerWithDocuments(new Map([[pageId, createDocument([connection])]]));
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as unknown as Pool;

    await revalidateActivePageConnections(server, pool, logger);

    expect(connection.close).toHaveBeenCalledWith({
      code: 4500,
      reason: 'Permission verification failed',
    });
  });
});
