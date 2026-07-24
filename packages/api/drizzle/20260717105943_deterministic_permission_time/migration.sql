-- Deterministic variants of the canonical permission functions. Production
-- wrappers retain the existing signatures and use NOW(); tests can pass an
-- exact instant, including the equality boundary where a grant is expired.

CREATE OR REPLACE FUNCTION get_effective_page_permission_at(
  p_page_id uuid,
  p_user_id uuid,
  p_as_of timestamptz
)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id       uuid;
  v_page_parent_id uuid;
  v_result         text;
BEGIN
  SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by), p.parent_id
  INTO v_owner_id, v_page_parent_id
  FROM pages p
  WHERE p.id = p_page_id AND p.is_deleted = false;

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'edit'::text, true;
    RETURN;
  END IF;

  SELECT perms.permission INTO v_result
  FROM (
    SELECT s.permission, 1 AS src
    FROM shares s
    WHERE s.entity_type = 'page'
      AND s.entity_id = p_page_id
      AND s.recipient_user_id = p_user_id
      AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

    UNION ALL

    SELECT s.permission, 2 AS src
    FROM shares s
    JOIN folders source_folder ON source_folder.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (
        SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id
      )
      AND s.recipient_user_id = p_user_id
      AND s.token IS NULL
      AND source_folder.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
      AND NOT is_page_folder_inheritance_blocked(s.entity_id, p_page_id)

    UNION ALL

    SELECT s.permission, 3 AS src
    FROM shares s
    WHERE s.entity_type = 'page'
      AND s.entity_id = p_page_id
      AND s.token IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM pages WHERE id = p_page_id AND is_public = true AND is_deleted = false
      )
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

    UNION ALL

    SELECT s.permission, 4 AS src
    FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
      AND EXISTS (
        SELECT 1
        FROM folder_closure fc
        WHERE fc.ancestor_id = f.id AND fc.descendant_id = v_page_parent_id
      )
      AND NOT is_page_folder_inheritance_blocked(s.entity_id, p_page_id)

    UNION ALL

    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
    END, 5 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_owner_id
      AND wm.member_id = p_user_id
      AND NOT is_page_path_restricted(p_page_id)
  ) perms
  ORDER BY CASE perms.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           perms.src ASC
  LIMIT 1;

  RETURN QUERY SELECT v_result, false;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE sql STABLE
AS $$
  SELECT * FROM get_effective_page_permission_at(p_page_id, p_user_id, NOW());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_folder_permission_at(
  p_folder_id uuid,
  p_user_id uuid,
  p_as_of timestamptz
)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id uuid;
  v_result   text;
BEGIN
  SELECT get_root_folder_owner(p_folder_id)
  INTO v_owner_id
  WHERE EXISTS (SELECT 1 FROM folders WHERE id = p_folder_id AND is_deleted = false);

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'admin'::text, true;
    RETURN;
  END IF;

  SELECT perms.permission INTO v_result
  FROM (
    SELECT s.permission, 1 AS src
    FROM shares s
    WHERE s.entity_type = 'folder'
      AND s.entity_id = p_folder_id
      AND s.recipient_user_id = p_user_id
      AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

    UNION ALL

    SELECT s.permission, 2 AS src
    FROM shares s
    JOIN folders source_folder ON source_folder.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (
        SELECT ancestor_id
        FROM folder_closure
        WHERE descendant_id = p_folder_id AND ancestor_id != p_folder_id
      )
      AND s.recipient_user_id = p_user_id
      AND s.token IS NULL
      AND source_folder.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
      AND NOT is_folder_inheritance_blocked(s.entity_id, p_folder_id)

    UNION ALL

    SELECT s.permission, 3 AS src
    FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
      AND EXISTS (
        SELECT 1
        FROM folder_closure fc
        WHERE fc.ancestor_id = f.id AND fc.descendant_id = p_folder_id
      )
      AND NOT is_folder_inheritance_blocked(s.entity_id, p_folder_id)

    UNION ALL

    SELECT CASE wm.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
    END, 4 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_owner_id
      AND wm.member_id = p_user_id
      AND NOT is_folder_path_restricted(p_folder_id)
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
LANGUAGE sql STABLE
AS $$
  SELECT * FROM get_effective_folder_permission_at(p_folder_id, p_user_id, NOW());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_page_base_permissions_at(p_page_id uuid, p_as_of timestamptz)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_container_owner_id uuid;
  v_page_parent_id     uuid;
BEGIN
  SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by), p.parent_id
  INTO v_container_owner_id, v_page_parent_id
  FROM pages p
  WHERE p.id = p_page_id AND p.is_deleted = false;

  RETURN QUERY
  WITH combined AS (
    SELECT s.recipient_user_id AS user_id, s.permission, 1 AS src
    FROM shares s
    WHERE s.entity_type = 'page'
      AND s.entity_id = p_page_id
      AND s.token IS NULL
      AND s.recipient_user_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

    UNION ALL

    SELECT s.recipient_user_id, s.permission, 2 AS src
    FROM shares s
    JOIN folders source_folder ON source_folder.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (
        SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id
      )
      AND s.token IS NULL
      AND s.recipient_user_id IS NOT NULL
      AND source_folder.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
      AND NOT is_page_folder_inheritance_blocked(s.entity_id, p_page_id)

    UNION ALL

    SELECT wm.member_id,
      CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END,
      3 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_container_owner_id
      AND NOT is_page_path_restricted(p_page_id)
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_page_base_permissions(p_page_id uuid)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE sql STABLE
AS $$
  SELECT * FROM get_page_base_permissions_at(p_page_id, NOW());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_accessible_page_ids_at(p_user_id uuid, p_as_of timestamptz)
RETURNS TABLE(page_id uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id
  FROM pages p
  WHERE p.is_deleted = false
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT 'edit'::text AS permission, 1 AS src
        WHERE COALESCE(get_root_folder_owner(p.parent_id), p.created_by) = p_user_id

        UNION ALL

        SELECT s.permission, 2 AS src
        FROM shares s
        WHERE s.entity_type = 'page'
          AND s.entity_id = p.id
          AND s.recipient_user_id = p_user_id
          AND s.token IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

        UNION ALL

        SELECT s.permission, 3 AS src
        FROM shares s
        JOIN folders source_folder ON source_folder.id = s.entity_id
        WHERE s.entity_type = 'folder'
          AND s.entity_id IN (
            SELECT ancestor_id FROM folder_closure WHERE descendant_id = p.parent_id
          )
          AND s.recipient_user_id = p_user_id
          AND s.token IS NULL
          AND source_folder.is_deleted = false
          AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
          AND NOT is_page_folder_inheritance_blocked(s.entity_id, p.id)

        UNION ALL

        SELECT s.permission, 4 AS src
        FROM page_access_events pae
        JOIN shares s
          ON s.entity_type = 'page'
         AND s.entity_id = pae.page_id
         AND s.token = pae.token
         AND s.token IS NOT NULL
        WHERE pae.user_id = p_user_id
          AND pae.source = 'link'
          AND pae.page_id = p.id
          AND p.is_public = true
          AND (s.expires_at IS NULL OR s.expires_at > p_as_of)

        UNION ALL

        SELECT s.permission, 5 AS src
        FROM folder_access_events fae
        JOIN shares s
          ON s.entity_type = 'folder'
         AND s.entity_id = fae.folder_id
         AND s.token = fae.token
         AND s.token IS NOT NULL
        JOIN folders source_folder ON source_folder.id = fae.folder_id
        WHERE fae.user_id = p_user_id
          AND fae.source = 'link'
          AND source_folder.is_public = true
          AND source_folder.is_deleted = false
          AND (s.expires_at IS NULL OR s.expires_at > p_as_of)
          AND EXISTS (
            SELECT 1
            FROM folder_closure fc
            WHERE fc.ancestor_id = fae.folder_id AND fc.descendant_id = p.parent_id
          )
          AND NOT is_page_folder_inheritance_blocked(fae.folder_id, p.id)

        UNION ALL

        SELECT CASE wm.role
          WHEN 'viewer' THEN 'view'
          WHEN 'editor' THEN 'edit'
          WHEN 'admin' THEN 'admin'
        END, 6 AS src
        FROM workspace_members wm
        WHERE wm.workspace_owner_id = COALESCE(get_root_folder_owner(p.parent_id), p.created_by)
          AND wm.member_id = p_user_id
          AND NOT is_page_path_restricted(p.id)
      ) perms
    );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_accessible_page_ids(p_user_id uuid)
RETURNS TABLE(page_id uuid)
LANGUAGE sql STABLE
AS $$
  SELECT * FROM get_accessible_page_ids_at(p_user_id, NOW());
$$;
