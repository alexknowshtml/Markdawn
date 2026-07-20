import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { executeQuery, type QueryExecutor } from '../db/query';
import { purgeEntityAccessMetadata } from './entityCleanup';
import { purgeUnreferencedUploadsForPages } from './uploadCleanup';

export async function purgeFolderSubtrees(
  executor: QueryExecutor,
  rootFolderIds: readonly string[],
): Promise<{ folders: number; pages: number }> {
  if (rootFolderIds.length === 0) {
    return { folders: 0, pages: 0 };
  }

  const folderResult = await executeQuery<{ id: string; is_deleted: boolean }>(
    executor,
    sql`select f.id, f.is_deleted
     from folders f
     where exists (
         select 1
         from folder_closure fc
         where fc.descendant_id = f.id
           and fc.ancestor_id = any(${sql.param([...rootFolderIds])}::uuid[])
       )
     order by f.id
     for update of f`,
  );
  const folderIds = folderResult.rows.map((row) => row.id);
  const folderById = new Map(folderResult.rows.map((row) => [row.id, row]));
  if (rootFolderIds.some((rootId) => folderById.get(rootId)?.is_deleted !== true)) {
    throw new HTTPException(409, { message: 'Folder was restored concurrently' });
  }
  if (folderResult.rows.some((folder) => !folder.is_deleted)) {
    throw new HTTPException(409, {
      message: 'Folder subtree contains active content and cannot be permanently deleted',
    });
  }

  const pageResult = await executeQuery<{ id: string; is_deleted: boolean }>(
    executor,
    sql`select p.id, p.is_deleted
     from pages p
     where p.parent_id = any(${sql.param(folderIds)}::uuid[])
     order by p.id
     for update of p`,
  );
  if (pageResult.rows.some((page) => !page.is_deleted)) {
    throw new HTTPException(409, {
      message: 'Folder subtree contains active content and cannot be permanently deleted',
    });
  }
  const pageIds = pageResult.rows.map((row) => row.id);

  await purgeUnreferencedUploadsForPages(executor, pageIds);
  await purgeEntityAccessMetadata(executor, 'page', pageIds);
  await purgeEntityAccessMetadata(executor, 'folder', folderIds);
  const deleteResult = await executeQuery(
    executor,
    sql`delete from folders where id = any(${sql.param([...rootFolderIds])}::uuid[]) and is_deleted = true`,
  );
  if ((deleteResult.rowCount ?? 0) !== rootFolderIds.length) {
    throw new HTTPException(409, { message: 'Folder was restored concurrently' });
  }

  return { folders: folderIds.length, pages: pageIds.length };
}
