CREATE FUNCTION get_account_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_parent_id uuid;
  v_result text;
BEGIN
  SELECT COALESCE(get_root_folder_owner(page.parent_id), page.created_by), page.parent_id
  INTO v_owner_id, v_parent_id
  FROM pages page
  WHERE page.id = p_page_id AND page.is_deleted = false;

  IF v_owner_id IS NULL THEN RETURN QUERY SELECT NULL::text, false; RETURN; END IF;
  IF v_owner_id = p_user_id THEN RETURN QUERY SELECT 'edit'::text, true; RETURN; END IF;

  SELECT candidate.permission INTO v_result
  FROM (
    SELECT share.permission, 1 AS source_rank
    FROM shares share
    WHERE share.entity_type = 'page' AND share.entity_id = p_page_id
      AND share.recipient_user_id = p_user_id
    UNION ALL
    SELECT share.permission, 2
    FROM shares share
    JOIN folders source ON source.id = share.entity_id
    WHERE share.entity_type = 'folder' AND share.recipient_user_id = p_user_id
      AND source.is_deleted = false
      AND share.entity_id IN (
        SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_parent_id
      )
      AND NOT is_page_folder_inheritance_blocked(share.entity_id, p_page_id)
    UNION ALL
    SELECT CASE member.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
      ELSE NULL
    END, 3
    FROM workspace_members member
    WHERE member.workspace_owner_id = v_owner_id AND member.member_id = p_user_id
      AND NOT is_page_path_restricted(p_page_id)
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;
  RETURN QUERY SELECT v_result, false;
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION is_active_session(p_user_id uuid, p_session_token text)
RETURNS boolean
LANGUAGE sql STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE token = p_session_token
      AND user_id = p_user_id
      AND expires_at > statement_timestamp()
  );
$function$;
--> statement-breakpoint

CREATE FUNCTION get_account_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_result text;
BEGIN
  SELECT get_root_folder_owner(p_folder_id) INTO v_owner_id
  WHERE EXISTS (SELECT 1 FROM folders WHERE id = p_folder_id AND is_deleted = false);
  IF v_owner_id IS NULL THEN RETURN QUERY SELECT NULL::text, false; RETURN; END IF;
  IF v_owner_id = p_user_id THEN RETURN QUERY SELECT 'admin'::text, true; RETURN; END IF;

  SELECT candidate.permission INTO v_result
  FROM (
    SELECT share.permission, 1 AS source_rank
    FROM shares share
    WHERE share.entity_type = 'folder' AND share.entity_id = p_folder_id
      AND share.recipient_user_id = p_user_id
    UNION ALL
    SELECT share.permission, 2
    FROM shares share
    JOIN folders source ON source.id = share.entity_id
    WHERE share.entity_type = 'folder' AND share.recipient_user_id = p_user_id
      AND source.is_deleted = false
      AND share.entity_id IN (
        SELECT ancestor_id FROM folder_closure
        WHERE descendant_id = p_folder_id AND ancestor_id <> p_folder_id
      )
      AND NOT is_folder_inheritance_blocked(share.entity_id, p_folder_id)
    UNION ALL
    SELECT CASE member.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
      ELSE NULL
    END, 3
    FROM workspace_members member
    WHERE member.workspace_owner_id = v_owner_id AND member.member_id = p_user_id
      AND NOT is_folder_path_restricted(p_folder_id)
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;
  RETURN QUERY SELECT v_result, false;
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION get_page_access_snapshot(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(
  account_permission text,
  public_permission text,
  permission text,
  full_access boolean
)
LANGUAGE sql STABLE
AS $function$
  WITH account AS MATERIALIZED (
    SELECT * FROM get_account_page_permission(p_page_id, p_user_id)
  ), public_access AS MATERIALIZED (
    SELECT get_public_page_permission(p_page_id) AS permission
  ), candidates AS (
    SELECT account.permission, account.full_access, 1 AS source_rank
    FROM account WHERE account.permission IS NOT NULL
    UNION ALL
    SELECT public_access.permission, false, 2
    FROM public_access WHERE public_access.permission IS NOT NULL
  ), effective AS (
    SELECT candidates.permission, candidates.full_access
    FROM candidates
    ORDER BY CASE candidates.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
             candidates.source_rank ASC
    LIMIT 1
  )
  SELECT account.permission, public_access.permission, effective.permission,
         COALESCE(effective.full_access, false)
  FROM account
  CROSS JOIN public_access
  LEFT JOIN effective ON true;
$function$;
--> statement-breakpoint

CREATE FUNCTION get_folder_access_snapshot(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(
  account_permission text,
  public_permission text,
  permission text,
  full_access boolean
)
LANGUAGE sql STABLE
AS $function$
  WITH account AS MATERIALIZED (
    SELECT * FROM get_account_folder_permission(p_folder_id, p_user_id)
  ), public_access AS MATERIALIZED (
    SELECT get_public_folder_permission(p_folder_id) AS permission
  ), candidates AS (
    SELECT account.permission, account.full_access, 1 AS source_rank
    FROM account WHERE account.permission IS NOT NULL
    UNION ALL
    SELECT public_access.permission, false, 2
    FROM public_access WHERE public_access.permission IS NOT NULL
  ), effective AS (
    SELECT candidates.permission, candidates.full_access
    FROM candidates
    ORDER BY CASE candidates.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
             candidates.source_rank ASC
    LIMIT 1
  )
  SELECT account.permission, public_access.permission, effective.permission,
         COALESCE(effective.full_access, false)
  FROM account
  CROSS JOIN public_access
  LEFT JOIN effective ON true;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE sql STABLE
AS $function$
  SELECT snapshot.permission, snapshot.full_access
  FROM get_page_access_snapshot(p_page_id, p_user_id) snapshot;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE sql STABLE
AS $function$
  SELECT snapshot.permission, snapshot.full_access
  FROM get_folder_access_snapshot(p_folder_id, p_user_id) snapshot;
$function$;
