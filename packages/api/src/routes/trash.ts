import { Hono } from 'hono';
import { db } from '../db/connection';
import { executeQuery } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { purgeEntityAccessMetadata } from '../utils/entityCleanup';
import { lockWorkspaceAccessMutation } from '../utils/share-access';
import { purgeFolderSubtrees } from '../utils/trashLifecycle';
import {
  processUploadDeletionQueue,
  purgeUnreferencedUploadsForPages,
} from '../utils/uploadCleanup';

const trashRoute = new Hono();
trashRoute.use('*', requireAuth);

const deletedFolderOwnerSql = `coalesce(
  (
    select root.created_by
    from folder_closure fc
    join folders root on root.id = fc.ancestor_id
    where fc.descendant_id = f.id
      and root.parent_id is null
    order by fc.depth desc
    limit 1
  ),
  f.created_by
)`;

trashRoute.delete('/empty-all', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await db.transaction(async (tx) => {
    await lockWorkspaceAccessMutation(tx, user.id);

    const roots = await executeQuery<{ id: string }>(
      tx,
      `select f.id
       from folders f
       left join folders parent on parent.id = f.parent_id
       where f.is_deleted = true
         and ${deletedFolderOwnerSql} = $1
         and coalesce(parent.is_deleted, false) = false
       order by f.id
       for update of f`,
      [user.id],
    );
    const folderCounts = await purgeFolderSubtrees(
      tx,
      roots.rows.map((row) => row.id),
    );

    const standalonePages = await executeQuery<{ id: string }>(
      tx,
      `select p.id
       from pages p
       left join folders parent on parent.id = p.parent_id
       where p.is_deleted = true
         and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $1
         and coalesce(parent.is_deleted, false) = false
       order by p.id
       for update of p`,
      [user.id],
    );
    const standalonePageIds = standalonePages.rows.map((row) => row.id);
    await purgeUnreferencedUploadsForPages(tx, standalonePageIds);
    await purgeEntityAccessMetadata(tx, 'page', standalonePageIds);
    if (standalonePageIds.length > 0) {
      await executeQuery(tx, 'delete from pages where id = any($1::uuid[]) and is_deleted = true', [
        standalonePageIds,
      ]);
    }

    return {
      folders: folderCounts.folders,
      pages: folderCounts.pages + standalonePageIds.length,
    };
  });
  await processUploadDeletionQueue();

  return c.json({ deleted: true, folders: result.folders, pages: result.pages });
});

export default trashRoute;
