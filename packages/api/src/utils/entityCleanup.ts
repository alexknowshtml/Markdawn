import { executeQuery, type QueryExecutor } from '../db/query';

type EntityType = 'folder' | 'page';

/**
 * Remove records whose polymorphic entity reference cannot be protected by a
 * database foreign key. Entity-specific access events are deleted explicitly
 * as well so a purge has one auditable cleanup path instead of relying on a
 * mix of manual deletes and cascades.
 */
export async function purgeEntityAccessMetadata(
  executor: QueryExecutor,
  entityType: EntityType,
  entityIds: readonly string[],
): Promise<void> {
  if (entityIds.length === 0) return;

  await executeQuery(
    executor,
    'delete from shares where entity_type = $1 and entity_id = any($2::uuid[])',
    [entityType, entityIds],
  );
  await executeQuery(
    executor,
    'delete from user_favorites where entity_type = $1 and entity_id = any($2::uuid[])',
    [entityType, entityIds],
  );

  if (entityType === 'page') {
    await executeQuery(executor, 'delete from page_access_events where page_id = any($1::uuid[])', [
      entityIds,
    ]);
    return;
  }

  await executeQuery(
    executor,
    'delete from folder_access_events where folder_id = any($1::uuid[])',
    [entityIds],
  );
}
