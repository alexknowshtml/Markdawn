-- Custom SQL migration: non-table database behavior that Drizzle cannot model.
-- Keep this append-only inside the baseline reset. Future changes should be new migrations.

-- =============================================================================
-- Data integrity checks
-- =============================================================================

ALTER TABLE "shares"
  ADD CONSTRAINT "shares_entity_type_check" CHECK (entity_type IN ('folder', 'page')),
  ADD CONSTRAINT "shares_permission_check" CHECK (permission IN ('view', 'edit', 'admin'));
--> statement-breakpoint

ALTER TABLE "page_access_events"
  ADD CONSTRAINT "page_access_events_permission_check" CHECK (permission IN ('view', 'edit', 'admin')),
  ADD CONSTRAINT "page_access_events_source_check" CHECK (source = 'link');
--> statement-breakpoint

ALTER TABLE "workspace_members"
  ADD CONSTRAINT "workspace_members_role_check" CHECK (role IN ('viewer', 'editor', 'admin'));
--> statement-breakpoint

ALTER TABLE "folders"
  ADD CONSTRAINT "folders_inheritance_policy_check" CHECK (inheritance_policy IN ('inherit', 'restricted'));
--> statement-breakpoint

ALTER TABLE "pages"
  ADD CONSTRAINT "pages_inheritance_policy_check" CHECK (inheritance_policy IN ('inherit', 'restricted'));
--> statement-breakpoint

-- =============================================================================
-- Folder closure maintenance
-- =============================================================================

CREATE OR REPLACE FUNCTION folder_closure_insert()
RETURNS TRIGGER AS $trg$
BEGIN
  INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
  VALUES (NEW.id, NEW.id, 0)
  ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = EXCLUDED.depth;

  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
    SELECT ancestor_id, NEW.id, depth + 1
    FROM folder_closure
    WHERE descendant_id = NEW.parent_id
    ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = EXCLUDED.depth;
  END IF;

  RETURN NEW;
END;
$trg$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER folders_closure_insert_trigger
AFTER INSERT ON folders
FOR EACH ROW EXECUTE FUNCTION folder_closure_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION folder_closure_update()
RETURNS TRIGGER AS $trg$
BEGIN
  IF OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM folder_closure
      WHERE ancestor_id = NEW.id AND descendant_id = NEW.parent_id
    ) THEN
      RAISE EXCEPTION 'Cannot move folder into its own subtree';
    END IF;
  END IF;

  DELETE FROM folder_closure
  WHERE descendant_id IN (
    SELECT descendant_id FROM folder_closure WHERE ancestor_id = NEW.id
  )
  AND ancestor_id NOT IN (
    SELECT descendant_id FROM folder_closure WHERE ancestor_id = NEW.id
  );

  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
    SELECT parent_path.ancestor_id, subtree.descendant_id, parent_path.depth + subtree.depth + 1
    FROM folder_closure parent_path
    CROSS JOIN folder_closure subtree
    WHERE parent_path.descendant_id = NEW.parent_id
      AND subtree.ancestor_id = NEW.id
    ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = EXCLUDED.depth;
  END IF;

  RETURN NEW;
END;
$trg$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER folders_closure_update_trigger
AFTER UPDATE OF parent_id ON folders
FOR EACH ROW EXECUTE FUNCTION folder_closure_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION folder_closure_delete()
RETURNS TRIGGER AS $trg$
BEGIN
  DELETE FROM folder_closure
  WHERE descendant_id IN (
    SELECT descendant_id FROM folder_closure WHERE ancestor_id = OLD.id
  );
  RETURN OLD;
END;
$trg$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER folders_closure_delete_trigger
AFTER DELETE ON folders
FOR EACH ROW EXECUTE FUNCTION folder_closure_delete();
--> statement-breakpoint

-- Rebuild is harmless on a fresh DB and protects manual imports before triggers existed.
DELETE FROM folder_closure;

WITH RECURSIVE rebuilt_closure(ancestor_id, descendant_id, depth, path) AS (
  SELECT id, id, 0, ARRAY[id]
  FROM folders

  UNION ALL

  SELECT rc.ancestor_id, child.id, rc.depth + 1, rc.path || child.id
  FROM rebuilt_closure rc
  JOIN folders child ON child.parent_id = rc.descendant_id
  WHERE NOT child.id = ANY(rc.path)
)
INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
SELECT ancestor_id, descendant_id, MIN(depth)
FROM rebuilt_closure
GROUP BY ancestor_id, descendant_id
ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = EXCLUDED.depth;
--> statement-breakpoint

-- =============================================================================
-- Sharing permission helpers
-- =============================================================================

CREATE OR REPLACE FUNCTION get_root_folder_owner(p_folder_id uuid)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT root.created_by
      FROM folder_closure fc
      JOIN folders root ON root.id = fc.ancestor_id
      WHERE fc.descendant_id = p_folder_id
        AND root.parent_id IS NULL
        AND root.is_deleted = false
      ORDER BY fc.depth DESC
      LIMIT 1
    ),
    (
      SELECT created_by
      FROM folders
      WHERE id = p_folder_id AND is_deleted = false
    )
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION is_folder_inheritance_blocked(
  p_source_folder_id uuid,
  p_target_folder_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM folder_closure source_to_barrier
    JOIN folder_closure barrier_to_target
      ON barrier_to_target.ancestor_id = source_to_barrier.descendant_id
    JOIN folders barrier
      ON barrier.id = source_to_barrier.descendant_id
    WHERE source_to_barrier.ancestor_id = p_source_folder_id
      AND barrier_to_target.descendant_id = p_target_folder_id
      AND source_to_barrier.descendant_id <> p_source_folder_id
      AND barrier.inheritance_policy = 'restricted'
      AND barrier.is_deleted = false
  );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION is_folder_path_restricted(p_folder_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM folder_closure fc
    JOIN folders f ON f.id = fc.ancestor_id
    WHERE fc.descendant_id = p_folder_id
      AND f.inheritance_policy = 'restricted'
      AND f.is_deleted = false
  );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION is_page_path_restricted(p_page_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_parent_id uuid;
  v_page_policy text;
BEGIN
  SELECT parent_id, inheritance_policy
  INTO v_parent_id, v_page_policy
  FROM pages
  WHERE id = p_page_id AND is_deleted = false;

  IF v_page_policy = 'restricted' THEN
    RETURN true;
  END IF;

  IF v_parent_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN is_folder_path_restricted(v_parent_id);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION is_page_folder_inheritance_blocked(
  p_source_folder_id uuid,
  p_page_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_parent_id uuid;
  v_page_policy text;
BEGIN
  SELECT parent_id, inheritance_policy
  INTO v_parent_id, v_page_policy
  FROM pages
  WHERE id = p_page_id AND is_deleted = false;

  IF v_page_policy = 'restricted' THEN
    RETURN true;
  END IF;

  IF v_parent_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN is_folder_inheritance_blocked(p_source_folder_id, v_parent_id);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
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
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.permission, 2 AS src
    FROM shares s
    JOIN folders source_folder ON source_folder.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id)
      AND s.recipient_user_id = p_user_id
      AND s.token IS NULL
      AND source_folder.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT is_page_folder_inheritance_blocked(s.entity_id, p_page_id)

    UNION ALL

    SELECT s.permission, 3 AS src
    FROM shares s
    WHERE s.entity_type = 'page'
      AND s.entity_id = p_page_id
      AND s.token IS NOT NULL
      AND EXISTS (SELECT 1 FROM pages WHERE id = p_page_id AND is_public = true AND is_deleted = false)
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.permission, 4 AS src
    FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
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

CREATE OR REPLACE FUNCTION get_effective_folder_permission(p_folder_id uuid, p_user_id uuid)
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
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

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
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT is_folder_inheritance_blocked(s.entity_id, p_folder_id)

    UNION ALL

    SELECT s.permission, 3 AS src
    FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
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

CREATE OR REPLACE FUNCTION get_page_base_permissions(p_page_id uuid)
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
      AND (s.expires_at IS NULL OR s.expires_at > NOW())

    UNION ALL

    SELECT s.recipient_user_id, s.permission, 2 AS src
    FROM shares s
    JOIN folders source_folder ON source_folder.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id)
      AND s.token IS NULL
      AND s.recipient_user_id IS NOT NULL
      AND source_folder.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
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

CREATE OR REPLACE FUNCTION get_accessible_page_ids(p_user_id uuid)
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
          AND (s.expires_at IS NULL OR s.expires_at > NOW())

        UNION ALL

        SELECT s.permission, 3 AS src
        FROM shares s
        JOIN folders source_folder ON source_folder.id = s.entity_id
        WHERE s.entity_type = 'folder'
          AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = p.parent_id)
          AND s.recipient_user_id = p_user_id
          AND s.token IS NULL
          AND source_folder.is_deleted = false
          AND (s.expires_at IS NULL OR s.expires_at > NOW())
          AND NOT is_page_folder_inheritance_blocked(s.entity_id, p.id)

        UNION ALL

        SELECT CASE wm.role
          WHEN 'viewer' THEN 'view'
          WHEN 'editor' THEN 'edit'
          WHEN 'admin' THEN 'admin'
        END, 4 AS src
        FROM workspace_members wm
        WHERE wm.workspace_owner_id = COALESCE(get_root_folder_owner(p.parent_id), p.created_by)
          AND wm.member_id = p_user_id
          AND NOT is_page_path_restricted(p.id)
      ) perms
    );
END;
$$;
