import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
  createTestWorkspaceMember,
} from '../test-utils';
import {
  lockEntityAccess,
  lockEntityAccessMutation,
  lockWorkspaceAccessMutation,
} from '../utils/share-access';

type ShareEvent = {
  type: 'share_event';
  action: string;
  entityType: 'page' | 'folder';
  entityId: string;
  metaUserIds?: string[];
  metaOnly?: boolean;
};

async function flushNotifications(payloads: string[]): Promise<ShareEvent[]> {
  const marker = `hierarchy-notification-marker:${crypto.randomUUID()}`;
  await query("select pg_notify('share_event', $1)", [marker]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const markerIndex = payloads.indexOf(marker);
    if (markerIndex >= 0) {
      const batch = payloads.splice(0, markerIndex + 1).slice(0, -1);
      return batch.flatMap((payload) => {
        try {
          const parsed = JSON.parse(payload) as Partial<ShareEvent>;
          return parsed.type === 'share_event' && parsed.entityId ? [parsed as ShareEvent] : [];
        } catch {
          return [];
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out flushing hierarchy notifications');
}

function expectSingleMetaOnlyEvent(
  events: ShareEvent[],
  entityType: 'page' | 'folder',
  entityId: string,
  expectedUsers: string[],
): void {
  const matching = events.filter(
    (event) => event.entityType === entityType && event.entityId === entityId,
  );
  expect(matching).toHaveLength(1);
  expect(matching[0]).toEqual(
    expect.objectContaining({
      action: 'recompute',
      entityType,
      entityId,
      metaOnly: true,
    }),
  );
  expect([...(matching[0]?.metaUserIds ?? [])].sort()).toEqual([...new Set(expectedUsers)].sort());
}

async function waitForWorkspaceLockWaiter(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await query<{ count: string }>(
      `select count(*)::text as count
       from pg_stat_activity
       where $1 = any(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for hierarchy mutation to reach the workspace lock');
}

describe('hierarchy creation notifications', () => {
  it('invalidates shared navigation once per create, copy, and import root', async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');

    const app = await createTestApp();
    const owner = await createTestUser();
    const workspaceMember = await createTestUser();
    const folderRecipient = await createTestUser();
    const expiredRecipient = await createTestUser();
    const inactiveLinkVisitor = await createTestUser();
    const session = await createTestSession(owner.id);
    await createTestWorkspaceMember(owner.id, workspaceMember.id, 'viewer');

    const listener = new Client({ connectionString });
    const payloads: string[] = [];
    listener.on('notification', (notification) => {
      if (notification.channel === 'share_event' && notification.payload) {
        payloads.push(notification.payload);
      }
    });
    await listener.connect();
    await listener.query('listen share_event');

    try {
      const folderRes = await app.request('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ name: 'Shared destination' }),
      });
      expect(folderRes.status).toBe(201);
      const folder = (await folderRes.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'folder', folder.id, [
        owner.id,
        workspaceMember.id,
      ]);

      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, recipient_email, permission
         ) values ('folder', $1, $2, $3, $4, 'view')`,
        [folder.id, owner.id, folderRecipient.id, folderRecipient.email],
      );
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, recipient_email,
           permission, expires_at
         ) values ('folder', $1, $2, $3, $4, 'view', now() - interval '1 minute')`,
        [folder.id, owner.id, expiredRecipient.id, expiredRecipient.email],
      );
      await query(
        `insert into folder_access_events (
           folder_id, user_id, source, token, permission, first_seen_at, last_seen_at
         ) values ($1, $2, 'link', $3, 'view', now(), now())`,
        [folder.id, inactiveLinkVisitor.id, `inactive-${crypto.randomUUID()}`],
      );

      const pageRes = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'New inherited page', parentId: folder.id }),
      });
      expect(pageRes.status).toBe(201);
      const page = (await pageRes.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'page', page.id, [
        owner.id,
        workspaceMember.id,
        folderRecipient.id,
      ]);

      const pageCopyRes = await app.request(`/api/pages/${page.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: folder.id }),
      });
      expect(pageCopyRes.status).toBe(201);
      const pageCopy = (await pageCopyRes.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'page', pageCopy.id, [
        owner.id,
        workspaceMember.id,
        folderRecipient.id,
      ]);

      const folderCopyRes = await app.request(`/api/folders/${folder.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ parentId: null }),
      });
      expect(folderCopyRes.status).toBe(201);
      const folderCopy = (await folderCopyRes.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'folder', folderCopy.id, [
        owner.id,
        workspaceMember.id,
      ]);

      const markdown = new FormData();
      markdown.append(
        'file',
        new File(['# Imported\n\nBody'], 'imported.md', { type: 'text/markdown' }),
      );
      const importRes = await app.request(`/api/import/markdown?parentId=${folder.id}`, {
        method: 'POST',
        headers: { Cookie: session.Cookie },
        body: markdown,
      });
      expect(importRes.status).toBe(201);
      const importedPage = (await importRes.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'page', importedPage.id, [
        owner.id,
        workspaceMember.id,
        folderRecipient.id,
      ]);

      const vaultRes = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({
          files: [
            { path: 'One/first.md', content: '# First' },
            { path: 'Two/second.md', content: '# Second' },
          ],
        }),
      });
      expect(vaultRes.status).toBe(201);
      const vaultEvents = (await flushNotifications(payloads)).filter(
        (event) => event.metaOnly === true,
      );
      expect(vaultEvents).toHaveLength(1);
      expect(vaultEvents[0]).toEqual(
        expect.objectContaining({
          action: 'recompute',
          metaUserIds: expect.arrayContaining([owner.id, workspaceMember.id]),
        }),
      );

      const restrictedFolder = await createTestFolder(owner.id, { name: 'Restricted parent' });
      await query("update folders set inheritance_policy = 'restricted' where id = $1", [
        restrictedFolder.id,
      ]);
      await query(
        `insert into shares (
           entity_type, entity_id, shared_by, recipient_user_id, recipient_email, permission
         ) values ('folder', $1, $2, $3, $4, 'view')`,
        [restrictedFolder.id, owner.id, folderRecipient.id, folderRecipient.email],
      );
      const restrictedPageResponse = await app.request('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ title: 'Restricted child', parentId: restrictedFolder.id }),
      });
      expect(restrictedPageResponse.status).toBe(201);
      const restrictedPage = (await restrictedPageResponse.json()) as { id: string };
      expectSingleMetaOnlyEvent(await flushNotifications(payloads), 'page', restrictedPage.id, [
        owner.id,
        folderRecipient.id,
      ]);

      const renewExpiredGrant = await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({ email: expiredRecipient.email, permission: 'view' }),
      });
      expect(renewExpiredGrant.status).toBe(200);
      const renewalEvents = await flushNotifications(payloads);
      expect(renewalEvents).toContainEqual(
        expect.objectContaining({
          action: 'grant',
          entityType: 'folder',
          entityId: folder.id,
          targetUserId: expiredRecipient.id,
        }),
      );
    } finally {
      await listener.end();
    }
  });

  it('fails closed when an entity changes workspaces while its access lock is acquired', async () => {
    const originalOwner = await createTestUser();
    const destinationOwner = await createTestUser();
    const page = await createTestPage(originalOwner.id, { title: 'Lock owner race' });
    const destination = await createTestFolder(destinationOwner.id, { name: 'Other workspace' });

    let releaseBlocker = (): void => undefined;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalBlockerReady = (_pid: number): void => undefined;
    const blockerReady = new Promise<number>((resolve) => {
      signalBlockerReady = resolve;
    });

    const blocker = db.transaction(async (tx) => {
      await lockWorkspaceAccessMutation(tx, originalOwner.id);
      const pidResult = await executeQuery<{ pid: number }>(tx, 'select pg_backend_pid() as pid');
      const pid = pidResult.rows[0]?.pid;
      if (pid === undefined) throw new Error('Failed to resolve blocker PID');
      signalBlockerReady(pid);
      await blockerRelease;
    });

    const blockerPid = await blockerReady;
    const contender = db.transaction((tx) => lockEntityAccessMutation(tx, 'page', page.id));

    try {
      await waitForWorkspaceLockWaiter(blockerPid);
      // Simulate a legacy/uncoordinated hierarchy write that lands in the
      // owner-resolution-to-lock gap. The helper must not continue under only
      // the stale original workspace lock.
      await query('update pages set parent_id = $1 where id = $2', [destination.id, page.id]);
      releaseBlocker();
      await expect(contender).rejects.toMatchObject({ status: 409 });
    } finally {
      releaseBlocker();
      await blocker;
    }
  });

  it('keeps lock-only reads revision-neutral while mutation locks advance the revision', async () => {
    const owner = await createTestUser();
    const page = await createTestPage(owner.id, { title: 'Revision-neutral read' });
    const readVersion = async (): Promise<bigint> => {
      const result = await query<{ version: string | null }>(
        `select (
           select version::text
           from workspace_access_versions
           where workspace_owner_id = $1
         ) as version`,
        [owner.id],
      );
      return BigInt(result.rows[0]?.version ?? '0');
    };

    const before = await readVersion();
    await db.transaction((tx) => lockEntityAccess(tx, 'page', page.id));
    expect(await readVersion()).toBe(before);

    await db.transaction((tx) => lockEntityAccessMutation(tx, 'page', page.id));
    expect(await readVersion()).toBeGreaterThan(before);
  });

  it('does not promote descendants to the workspace root after an import parent fails', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const blockedParent = `blocked-parent-${suffix}`;
    const functionName = `test_fail_import_folder_${suffix}`;
    const triggerName = `test_fail_import_folder_trigger_${suffix}`;

    await query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.name = '${blockedParent}' then
          raise exception 'forced parent folder failure';
        end if;
        return new;
      end
      $$
    `);
    await query(
      `create trigger ${triggerName}
       before insert on folders
       for each row execute function ${functionName}()`,
    );

    try {
      const response = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({
          files: [{ path: `${blockedParent}/child/note.md`, content: '# Nested note' }],
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        foldersCreated: 0,
        pagesCreated: 0,
        errors: [
          expect.stringContaining('forced parent folder failure'),
          expect.stringContaining(`Parent folder "${blockedParent}" was not created`),
          expect.stringContaining(`Parent folder "${blockedParent}/child" was not created`),
        ],
      });

      const leakedHierarchy = await query<{ count: string }>(
        `select (
           (select count(*) from folders where created_by = $1 and name in ('child', $2))
           + (select count(*) from pages where created_by = $1 and title = 'Nested note')
         )::text as count`,
        [owner.id, blockedParent],
      );
      expect(leakedHierarchy.rows[0]?.count).toBe('0');
    } finally {
      await query(`drop trigger if exists ${triggerName} on folders`);
      await query(`drop function if exists ${functionName}()`);
    }
  });

  it('rolls back an imported page when its dependent metadata fails', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const failingTagName = `rollback_${suffix}`;
    const failingTagSlug = `#${failingTagName}`;
    const pageTitle = `Rollback ${suffix}`;
    const functionName = `test_fail_import_connection_${suffix}`;
    const triggerName = `test_fail_import_connection_trigger_${suffix}`;

    await query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.target_slug = '${failingTagSlug}' then
          raise exception 'forced page metadata failure';
        end if;
        return new;
      end
      $$
    `);
    await query(
      `create trigger ${triggerName}
       before insert on connections
       for each row execute function ${functionName}()`,
    );

    try {
      const response = await app.request('/api/import/obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.Cookie },
        body: JSON.stringify({
          files: [
            {
              path: `rollback-${suffix}.md`,
              content: `# ${pageTitle}\n\n#${failingTagName}`,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        pagesCreated: 0,
        errors: [expect.stringContaining('forced page metadata failure')],
      });

      const leakedPage = await query<{ count: string }>(
        'select count(*)::text as count from pages where created_by = $1 and title = $2',
        [owner.id, pageTitle],
      );
      expect(leakedPage.rows[0]?.count).toBe('0');
    } finally {
      await query(`drop trigger if exists ${triggerName} on connections`);
      await query(`drop function if exists ${functionName}()`);
    }
  });
});
