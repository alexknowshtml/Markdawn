import { executeQuery, type QueryExecutor } from '../db/query';

type ShareEntityType = 'folder' | 'page';

/**
 * Return every account whose current navigation or effective access can be
 * affected by a hierarchy mutation. Expired grants, inactive link history,
 * and workspace membership blocked by a restriction are deliberately omitted;
 * granting or re-enabling those sources emits its own invalidation.
 */
export async function getEntityMetaUserIds(
  executor: QueryExecutor,
  entityType: ShareEntityType,
  entityId: string,
): Promise<string[]> {
  const statement =
    entityType === 'page'
      ? `with target as (
           select p.id, p.parent_id,
                  coalesce(get_root_folder_owner(p.parent_id), p.created_by) as owner_id
           from pages p
           where p.id = $1
         ),
         source_folders as (
           select fc.ancestor_id as id
           from target t
           join folder_closure fc on fc.descendant_id = t.parent_id
         ),
         candidate_users as (
           select owner_id as user_id from target
           union all
           select wm.member_id from target t
           join workspace_members wm on wm.workspace_owner_id = t.owner_id
           union all
           select s.recipient_user_id from shares s
           where s.entity_type = 'page' and s.entity_id = $1
           union all
           select s.recipient_user_id from shares s
           where s.entity_type = 'folder' and s.entity_id in (select id from source_folders)
           union all
           select pae.user_id from page_access_events pae where pae.page_id = $1
           union all
           select fae.user_id from folder_access_events fae
           where fae.folder_id in (select id from source_folders)
         )
         select distinct candidate.user_id
         from candidate_users candidate
         cross join target
         where candidate.user_id is not null
           and (
             candidate.user_id = target.owner_id
             or exists (
               select 1
               from get_accessible_page_ids(candidate.user_id) accessible
               where accessible.page_id = $1
             )
           )`
      : `with target_folders as (
           select fc.descendant_id as id
           from folder_closure fc
           where fc.ancestor_id = $1
         ),
         target_pages as (
           select p.id from pages p where p.parent_id in (select id from target_folders)
         ),
         source_folders as (
           select fc.ancestor_id as id
           from folder_closure fc
           where fc.descendant_id = $1
           union
           select id from target_folders
         ),
         target as (
           select get_root_folder_owner($1) as owner_id
         ),
         candidate_users as (
           select owner_id as user_id from target
           union all
           select wm.member_id from target t
           join workspace_members wm on wm.workspace_owner_id = t.owner_id
           union all
           select s.recipient_user_id from shares s
           where s.entity_type = 'folder' and s.entity_id in (select id from source_folders)
           union all
           select s.recipient_user_id from shares s
           where s.entity_type = 'page' and s.entity_id in (select id from target_pages)
           union all
           select fae.user_id from folder_access_events fae
           where fae.folder_id in (select id from source_folders)
           union all
           select pae.user_id from page_access_events pae
           where pae.page_id in (select id from target_pages)
         )
         select distinct candidate.user_id
         from candidate_users candidate
         cross join target
         where candidate.user_id is not null
           and (
             candidate.user_id = target.owner_id
             or exists (
               select 1
               from target_pages target_page
               join lateral get_accessible_page_ids(candidate.user_id) accessible
                 on accessible.page_id = target_page.id
             )
             or exists (
               select 1
               from target_folders target_folder
               join folders visible_folder on visible_folder.id = target_folder.id
               where visible_folder.is_deleted = false
                 and (
                   get_root_folder_owner(visible_folder.id) = candidate.user_id
                   or exists (
                     select 1
                     from shares direct_share
                     where direct_share.entity_type = 'folder'
                       and direct_share.entity_id = visible_folder.id
                       and direct_share.recipient_user_id = candidate.user_id
                       and direct_share.token is null
                       and (
                         direct_share.expires_at is null
                         or direct_share.expires_at > statement_timestamp()
                       )
                   )
                   or exists (
                     select 1
                     from shares inherited_share
                     join folders source_folder on source_folder.id = inherited_share.entity_id
                     where inherited_share.entity_type = 'folder'
                       and inherited_share.entity_id in (
                         select ancestor_id
                         from folder_closure
                         where descendant_id = visible_folder.id
                           and ancestor_id != visible_folder.id
                       )
                       and inherited_share.recipient_user_id = candidate.user_id
                       and inherited_share.token is null
                       and source_folder.is_deleted = false
                       and (
                         inherited_share.expires_at is null
                         or inherited_share.expires_at > statement_timestamp()
                       )
                       and not is_folder_inheritance_blocked(
                         inherited_share.entity_id,
                         visible_folder.id
                       )
                   )
                   or exists (
                     select 1
                     from folder_access_events access_event
                     join shares link_share
                       on link_share.entity_type = 'folder'
                      and link_share.entity_id = access_event.folder_id
                      and link_share.token = access_event.token
                      and link_share.token is not null
                     join folders source_folder on source_folder.id = access_event.folder_id
                     where access_event.user_id = candidate.user_id
                       and access_event.source = 'link'
                       and source_folder.is_public = true
                       and source_folder.is_deleted = false
                       and (
                         link_share.expires_at is null
                         or link_share.expires_at > statement_timestamp()
                       )
                       and visible_folder.id in (
                         select descendant_id
                         from folder_closure
                         where ancestor_id = access_event.folder_id
                       )
                       and not is_folder_inheritance_blocked(
                         access_event.folder_id,
                         visible_folder.id
                       )
                   )
                   or exists (
                     select 1
                     from workspace_members member
                     where member.workspace_owner_id = get_root_folder_owner(visible_folder.id)
                       and member.member_id = candidate.user_id
                       and not is_folder_path_restricted(visible_folder.id)
                   )
                 )
             )
           )`;

  const result = await executeQuery<{ user_id: string }>(executor, statement, [entityId]);
  return result.rows.map((row) => row.user_id);
}

export function mergeMetaUserIds(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())];
}
