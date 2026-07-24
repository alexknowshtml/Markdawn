import { sql } from 'drizzle-orm';
import { executeQuery, type QueryExecutor } from '../db/query';

export async function getDestinationOwnerId(
  executor: QueryExecutor,
  parentId: string | null,
  rootOwnerId: string | null,
): Promise<string | null> {
  if (!parentId) return rootOwnerId;
  return (
    (
      await executeQuery<{ owner_id: string | null }>(
        executor,
        sql`select get_root_folder_owner(${parentId}) as owner_id`,
      )
    ).rows[0]?.owner_id ?? null
  );
}
