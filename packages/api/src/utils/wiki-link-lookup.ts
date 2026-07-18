import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';

/**
 * Build a lookup for the pages one requester can enumerate in one effective
 * workspace. Unqualified titles are included only when unique among those
 * pages. Explicit paths use only requester-visible folder ancestry, so a
 * direct page grant cannot be used to probe hidden parent folder names.
 */
export async function getUniqueWorkspacePageLookup(
  ownerId: string,
  requesterUserId: string,
  executor: QueryExecutor = db,
): Promise<Map<string, string>> {
  const result = await executeQuery<{
    lookup_key: string;
    page_id: string;
  }>(
    executor,
    `with recursive access_snapshot as materialized (
       select statement_timestamp() as as_of
     ),
     enumerable_folders as materialized (
       select enumerable.folder_id
       from access_snapshot snapshot
       cross join lateral get_enumerable_folder_ids_at($2, snapshot.as_of) enumerable
     ),
     accessible_pages as materialized (
       select accessible.page_id
       from access_snapshot snapshot
       cross join lateral get_accessible_page_ids_at($2, snapshot.as_of) accessible
     ),
     visible_folders as materialized (
       select f.id, f.parent_id, f.name
       from folders f
       where f.is_deleted = false
         and get_root_folder_owner(f.id) = $1
         and f.id in (select folder_id from enumerable_folders)
     ),
     folder_paths as (
       select f.id, lower(trim(f.name))::text as folder_path
       from visible_folders f
       where not exists (
         select 1 from visible_folders parent where parent.id = f.parent_id
       )

       union all

       select child.id,
              (parent.folder_path || '/' || lower(trim(child.name)))::text as folder_path
       from visible_folders child
       join folder_paths parent on parent.id = child.parent_id
     ),
     workspace_pages as (
       select p.id,
              lower(trim(p.title)) as title_key,
              case
                when p.parent_id is null then lower(trim(p.title))
                else paths.folder_path || '/' || lower(trim(p.title))
              end as path_key
       from pages p
       left join folder_paths paths on paths.id = p.parent_id
       where p.is_deleted = false
         and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $1
         and p.id in (select page_id from accessible_pages)
     ),
     unique_titles as (
       select title_key as lookup_key, min(id::text) as page_id
       from workspace_pages
       where title_key <> ''
       group by title_key
       having count(*) = 1
     ),
     unique_paths as (
       select path_key as lookup_key, min(id::text) as page_id
       from workspace_pages
       where path_key like '%/%'
       group by path_key
       having count(*) = 1
     )
     select lookup_key, page_id from unique_titles
     union all
     select lookup_key, page_id from unique_paths`,
    [ownerId, requesterUserId],
  );

  return new Map(result.rows.map((row) => [row.lookup_key, row.page_id]));
}
