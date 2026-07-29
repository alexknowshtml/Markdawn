-- Extend get_account_page_permission to also check workspace_memberships
-- when pages.workspace_id is set (new org/workspace model).
-- Existing content has workspace_id = NULL so this is a no-op for legacy data.

CREATE OR REPLACE FUNCTION get_account_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_parent_id uuid;
  v_workspace_id uuid;
  v_result text;
BEGIN
  SELECT COALESCE(get_root_folder_owner(page.parent_id), page.created_by),
         page.parent_id,
         page.workspace_id
  INTO v_owner_id, v_parent_id, v_workspace_id
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
    UNION ALL
    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
      ELSE NULL
    END, 3
    FROM workspace_memberships wm
    WHERE v_workspace_id IS NOT NULL
      AND wm.workspace_id = v_workspace_id
      AND wm.user_id = p_user_id
      AND NOT is_page_path_restricted(p_page_id)
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;
  RETURN QUERY SELECT v_result, false;
END;
$function$;
--> statement-breakpoint

-- Extend get_account_folder_permission similarly.

CREATE OR REPLACE FUNCTION get_account_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_workspace_id uuid;
  v_result text;
BEGIN
  SELECT get_root_folder_owner(p_folder_id) INTO v_owner_id
  WHERE EXISTS (SELECT 1 FROM folders WHERE id = p_folder_id AND is_deleted = false);
  IF v_owner_id IS NULL THEN RETURN QUERY SELECT NULL::text, false; RETURN; END IF;
  IF v_owner_id = p_user_id THEN RETURN QUERY SELECT 'admin'::text, true; RETURN; END IF;

  SELECT f.workspace_id INTO v_workspace_id FROM folders f WHERE f.id = p_folder_id;

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
    UNION ALL
    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
      ELSE NULL
    END, 3
    FROM workspace_memberships wm
    WHERE v_workspace_id IS NOT NULL
      AND wm.workspace_id = v_workspace_id
      AND wm.user_id = p_user_id
      AND NOT is_folder_path_restricted(p_folder_id)
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;
  RETURN QUERY SELECT v_result, false;
END;
$function$;
