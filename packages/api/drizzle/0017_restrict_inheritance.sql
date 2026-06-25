CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id         uuid;
  v_page_parent_id   uuid;
  v_restricted       boolean;
  v_result           text;
BEGIN
  SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by), p.parent_id
  INTO v_owner_id, v_page_parent_id
  FROM pages p WHERE p.id = p_page_id AND p.is_deleted = false;

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'edit'::text, true;
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pages p
    WHERE p.id = p_page_id
      AND p.is_access_restricted = true
      AND p.is_deleted = false

    UNION ALL

    SELECT 1 FROM folder_closure fc
    JOIN folders f ON f.id = fc.ancestor_id
    WHERE fc.descendant_id = v_page_parent_id
      AND f.is_access_restricted = true AND f.is_deleted = false
  ) INTO v_restricted;

  SELECT perms.permission INTO v_result
  FROM (
    SELECT s.permission, 1 AS src FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.permission, 2 AS src FROM shares s
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id)
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT s.permission, 3 AS src FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.token IS NOT NULL
      AND EXISTS (SELECT 1 FROM pages WHERE id = p_page_id AND is_public = true)
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT s.permission, 4 AS src FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id)
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
    END, 5 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_owner_id AND wm.member_id = p_user_id
      AND NOT v_restricted
  ) perms
  ORDER BY CASE perms.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           perms.src ASC
  LIMIT 1;

  RETURN QUERY SELECT v_result, false;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id         uuid;
  v_restricted       boolean;
  v_result           text;
BEGIN
  SELECT get_root_folder_owner(p_folder_id) INTO v_owner_id;

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'admin'::text, true;
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM folders WHERE id = p_folder_id AND is_access_restricted = true AND is_deleted = false
    UNION ALL
    SELECT 1 FROM folder_closure fc
    JOIN folders f ON f.id = fc.ancestor_id
    WHERE fc.descendant_id = p_folder_id
      AND f.is_access_restricted = true AND f.is_deleted = false
      AND fc.ancestor_id != p_folder_id
  ) INTO v_restricted;

  SELECT perms.permission INTO v_result
  FROM (
    SELECT s.permission, 1 AS src FROM shares s
    WHERE s.entity_type = 'folder' AND s.entity_id = p_folder_id
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.permission, 2 AS src FROM shares s
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = p_folder_id AND ancestor_id != p_folder_id)
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT s.permission, 3 AS src FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = p_folder_id)
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
    END, 4 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_owner_id AND wm.member_id = p_user_id
      AND NOT v_restricted
  ) perms
  ORDER BY CASE perms.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           perms.src ASC
  LIMIT 1;

  RETURN QUERY SELECT v_result, false;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_page_base_permissions(p_page_id uuid)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_container_owner_id uuid;
  v_restricted         boolean;
BEGIN
  SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by) INTO v_container_owner_id
  FROM pages p WHERE p.id = p_page_id AND p.is_deleted = false;

  SELECT EXISTS(
    SELECT 1 FROM pages p
    WHERE p.id = p_page_id AND p.is_access_restricted = true AND p.is_deleted = false
    UNION ALL
    SELECT 1 FROM folder_closure fc
    JOIN folders f ON f.id = fc.ancestor_id
    WHERE fc.descendant_id = (SELECT parent_id FROM pages WHERE id = p_page_id)
      AND f.is_access_restricted = true AND f.is_deleted = false
  ) INTO v_restricted;

  RETURN QUERY
  WITH combined AS (
    SELECT s.recipient_user_id AS user_id, s.permission, 1 AS src FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.token IS NULL AND s.recipient_user_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.recipient_user_id, s.permission, 2 AS src FROM shares s
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure fc JOIN pages p ON p.id = p_page_id WHERE fc.descendant_id = p.parent_id)
      AND s.token IS NULL AND s.recipient_user_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_restricted

    UNION ALL

    SELECT wm.member_id, CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END, 4 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_container_owner_id
      AND NOT v_restricted
  ),
  ranked AS (
    SELECT DISTINCT ON (combined.user_id) combined.user_id, combined.permission
    FROM combined
    ORDER BY combined.user_id,
      CASE combined.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
      combined.src ASC
  )
  SELECT v_container_owner_id, 'edit'::text WHERE v_container_owner_id IS NOT NULL
  UNION
  SELECT ranked.user_id, ranked.permission FROM ranked;
END;
$$;
