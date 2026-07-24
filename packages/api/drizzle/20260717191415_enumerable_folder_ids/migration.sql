DELETE FROM "folder_access_events";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION get_enumerable_folder_ids_at(
  p_user_id uuid,
  p_as_of timestamptz
)
RETURNS TABLE(folder_id uuid)
LANGUAGE sql STABLE
AS $function$
  WITH enumerable_folders AS (
    SELECT folder.id AS folder_id
    FROM folders folder
    WHERE folder.is_deleted = false
      AND get_root_folder_owner(folder.id) = p_user_id

    UNION

    SELECT target.id AS folder_id
    FROM folders target
    JOIN folder_closure path ON path.descendant_id = target.id
    JOIN folders source ON source.id = path.ancestor_id
    JOIN shares account_share
      ON account_share.entity_type = 'folder'
     AND account_share.entity_id = source.id
     AND account_share.recipient_user_id = p_user_id
     AND account_share.token IS NULL
    WHERE target.is_deleted = false
      AND source.is_deleted = false
      AND (account_share.expires_at IS NULL OR account_share.expires_at > p_as_of)
      AND (
        source.id = target.id
        OR NOT is_folder_inheritance_blocked(source.id, target.id)
      )

    UNION

    SELECT folder.id AS folder_id
    FROM folders folder
    JOIN workspace_members member
      ON member.workspace_owner_id = get_root_folder_owner(folder.id)
     AND member.member_id = p_user_id
    WHERE folder.is_deleted = false
      AND NOT is_folder_path_restricted(folder.id)

    UNION

    SELECT target.id AS folder_id
    FROM folder_access_events access_event
    JOIN shares link_share
      ON link_share.entity_type = 'folder'
     AND link_share.entity_id = access_event.folder_id
     AND link_share.token = access_event.token
     AND link_share.token IS NOT NULL
    JOIN folders source ON source.id = access_event.folder_id
    JOIN folder_closure path ON path.ancestor_id = source.id
    JOIN folders target ON target.id = path.descendant_id
    WHERE access_event.user_id = p_user_id
      AND access_event.source = 'link'
      AND source.is_public = true
      AND source.is_deleted = false
      AND target.is_deleted = false
      AND (link_share.expires_at IS NULL OR link_share.expires_at > p_as_of)
      AND (
        source.id = target.id
        OR NOT is_folder_inheritance_blocked(source.id, target.id)
      )
  )
  SELECT folder_id
  FROM enumerable_folders;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION get_enumerable_folder_ids(p_user_id uuid)
RETURNS TABLE(folder_id uuid)
LANGUAGE sql STABLE
AS $function$
  SELECT folder_id
  FROM get_enumerable_folder_ids_at(p_user_id, statement_timestamp());
$function$;
