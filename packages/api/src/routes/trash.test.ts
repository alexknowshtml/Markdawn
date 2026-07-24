import { describe, expect, it } from 'vitest';
import { testQuery as query } from '../db/testQuery';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

describe('trash API', () => {
  it('requires authentication to empty Trash', async () => {
    const app = await createTestApp();
    const res = await app.request('/api/trash/empty-all', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('shows only independent page roots and atomically purges page and folder trash', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const folder = await createTestFolder(owner.id, { name: 'Deleted folder' });
    const child = await createTestFolder(owner.id, {
      name: 'Deleted child folder',
      parentId: folder.id,
    });
    const nestedPage = await createTestPage(owner.id, {
      title: 'Nested deleted page',
      parentId: child.id,
    });
    const standalonePage = await createTestPage(owner.id, { title: 'Standalone deleted page' });

    const folderTrashRes = await app.request(`/api/folders/${folder.id}?force=true`, {
      method: 'DELETE',
      headers: { Cookie: session.Cookie },
    });
    expect(folderTrashRes.status).toBe(200);
    const pageTrashRes = await app.request(`/api/pages/${standalonePage.id}`, {
      method: 'DELETE',
      headers: { Cookie: session.Cookie },
    });
    expect(pageTrashRes.status).toBe(200);

    const pageListRes = await app.request('/api/pages/trash', {
      headers: { Cookie: session.Cookie },
    });
    expect(pageListRes.status).toBe(200);
    const pageTrash = (await pageListRes.json()) as Array<{ id: string }>;
    expect(pageTrash.map((page) => page.id)).toEqual([standalonePage.id]);

    const folderListRes = await app.request('/api/folders/trash', {
      headers: { Cookie: session.Cookie },
    });
    expect(folderListRes.status).toBe(200);
    const folderTrash = (await folderListRes.json()) as Array<{ id: string }>;
    expect(folderTrash.map((item) => item.id)).toEqual([folder.id]);

    const emptyRes = await app.request('/api/trash/empty-all', {
      method: 'DELETE',
      headers: { Cookie: session.Cookie },
    });
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual({ deleted: true, folders: 2, pages: 2 });

    const leftovers = await query<{ folders: string; pages: string }>(
      `select
         (select count(*) from folders where id = any($1::uuid[]))::text as folders,
         (select count(*) from pages where id = any($2::uuid[]))::text as pages`,
      [
        [folder.id, child.id],
        [nestedPage.id, standalonePage.id],
      ],
    );
    expect(leftovers.rows[0]).toEqual({ folders: '0', pages: '0' });
  });

  it('fails closed instead of cascading through legacy active descendants', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const root = await createTestFolder(owner.id, { name: 'Legacy deleted root' });
    const child = await createTestFolder(owner.id, {
      name: 'Legacy active child',
      parentId: root.id,
    });
    const page = await createTestPage(owner.id, {
      title: 'Legacy active page',
      parentId: child.id,
    });

    // Simulate state created before recursive Trash semantics existed. The
    // current parent trigger permits deleting a folder and therefore cannot
    // itself repair already-active descendants.
    await query(
      `update folders
       set is_deleted = true, deleted_at = now(), deletion_batch_id = gen_random_uuid()
       where id = $1`,
      [root.id],
    );

    const purgeRes = await app.request(`/api/folders/${root.id}/permanent`, {
      method: 'DELETE',
      headers: { Cookie: session.Cookie },
    });
    expect(purgeRes.status).toBe(409);

    const survivors = await query<{ root: string; child: string; page: string }>(
      `select
         (select count(*) from folders where id = $1)::text as root,
         (select count(*) from folders where id = $2 and is_deleted = false)::text as child,
         (select count(*) from pages where id = $3 and is_deleted = false)::text as page`,
      [root.id, child.id, page.id],
    );
    expect(survivors.rows[0]).toEqual({ root: '1', child: '1', page: '1' });
  });
});
