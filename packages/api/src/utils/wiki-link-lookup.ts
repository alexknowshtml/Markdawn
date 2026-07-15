import { query } from '../db/query';

/**
 * Build a lookup for one effective workspace. Unqualified titles are included
 * only when unique. Explicit folder/page paths are also included when unique,
 * so an exact path wins without exposing or binding to another workspace.
 */
export async function getUniqueWorkspacePageLookup(ownerId: string): Promise<Map<string, string>> {
  const result = await query<{
    lookup_key: string;
    page_id: string;
  }>(
    `with recursive folder_paths as (
       select f.id, lower(trim(f.name))::text as folder_path
       from folders f
       where f.parent_id is null
         and f.created_by = $1
         and f.is_deleted = false

       union all

       select child.id,
              (parent.folder_path || '/' || lower(trim(child.name)))::text as folder_path
       from folders child
       join folder_paths parent on parent.id = child.parent_id
       where child.is_deleted = false
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
    [ownerId],
  );

  return new Map(result.rows.map((row) => [row.lookup_key, row.page_id]));
}
