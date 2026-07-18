import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';

export async function getEnumerableFolderIds(
  userId: string,
  executor: QueryExecutor = db,
): Promise<Set<string>> {
  const result = await executeQuery<{ folder_id: string }>(
    executor,
    'select folder_id from get_enumerable_folder_ids($1)',
    [userId],
  );
  return new Set(result.rows.map((row) => row.folder_id));
}

export function redactParentId(
  parentId: string | null,
  enumerableFolderIds: ReadonlySet<string>,
): string | null {
  return parentId && enumerableFolderIds.has(parentId) ? parentId : null;
}
