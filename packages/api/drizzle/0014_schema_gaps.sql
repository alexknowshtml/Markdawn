BEGIN;

-- =============================================================================
-- COLUMNS & TABLES
-- =============================================================================

ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "properties" jsonb;
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "is_access_restricted" boolean DEFAULT false;
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false;
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "public_token" text;

CREATE TABLE IF NOT EXISTS "folder_closure" (
  "ancestor_id" uuid NOT NULL REFERENCES "folders"("id") ON DELETE CASCADE,
  "descendant_id" uuid NOT NULL REFERENCES "folders"("id") ON DELETE CASCADE,
  "depth" integer NOT NULL,
  CONSTRAINT "folder_closure_pk" UNIQUE("ancestor_id", "descendant_id")
);
CREATE INDEX IF NOT EXISTS "folder_closure_descendant_idx" ON "folder_closure" ("descendant_id");
CREATE INDEX IF NOT EXISTS "folder_closure_ancestor_idx" ON "folder_closure" ("ancestor_id");

-- =============================================================================
-- FOLDER CLOSURE TRIGGERS
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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'folders_closure_insert_trigger') THEN
    CREATE TRIGGER folders_closure_insert_trigger
    AFTER INSERT ON folders FOR EACH ROW EXECUTE FUNCTION folder_closure_insert();
  END IF;
END $$;

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'folders_closure_update_trigger') THEN
    CREATE TRIGGER folders_closure_update_trigger
    AFTER UPDATE OF parent_id ON folders FOR EACH ROW EXECUTE FUNCTION folder_closure_update();
  END IF;
END $$;

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'folders_closure_delete_trigger') THEN
    CREATE TRIGGER folders_closure_delete_trigger
    AFTER DELETE ON folders FOR EACH ROW EXECUTE FUNCTION folder_closure_delete();
  END IF;
END $$;

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

-- =============================================================================
-- WORKSPACE ROLES: migrate from ('member','admin') to ('viewer','editor','admin')
-- =============================================================================

UPDATE workspace_members SET role = 'editor' WHERE role = 'member';
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('viewer', 'editor', 'admin'));
ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'editor';

-- =============================================================================
-- DROP FK THAT BLOCKS FOLDER SHARES
-- =============================================================================

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_entity_id_fk;

-- =============================================================================
-- PERMISSION FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION get_root_folder_owner(p_folder_id UUID)
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT f2.created_by FROM folder_closure fc
     JOIN folders f2 ON f2.id = fc.ancestor_id
     WHERE fc.descendant_id = p_folder_id AND f2.parent_id IS NULL
     ORDER BY fc.depth DESC LIMIT 1),
    (SELECT created_by FROM folders WHERE id = p_folder_id)
  );
$$;

CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id         uuid;
  v_page_parent_id   uuid;
  v_restricted       boolean;
  v_has_direct_share boolean;
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

  SELECT EXISTS(
    SELECT 1 FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
  ) INTO v_has_direct_share;

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
      AND NOT v_has_direct_share

    UNION ALL

    SELECT s.permission, 3 AS src FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.token IS NOT NULL
      AND EXISTS (SELECT 1 FROM pages WHERE id = p_page_id AND is_public = true)
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_has_direct_share

    UNION ALL

    SELECT s.permission, 4 AS src FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_page_parent_id)
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_has_direct_share

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

CREATE OR REPLACE FUNCTION get_effective_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_owner_id         uuid;
  v_restricted       boolean;
  v_has_direct_share boolean;
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

  SELECT EXISTS(
    SELECT 1 FROM shares s
    WHERE s.entity_type = 'folder' AND s.entity_id = p_folder_id
      AND s.recipient_user_id = p_user_id AND s.token IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
  ) INTO v_has_direct_share;

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
      AND NOT v_has_direct_share

    UNION ALL

    SELECT s.permission, 3 AS src FROM shares s
    JOIN folders f ON f.id = s.entity_id
    WHERE s.entity_type = 'folder'
      AND s.entity_id IN (SELECT ancestor_id FROM folder_closure WHERE descendant_id = p_folder_id)
      AND s.token IS NOT NULL
      AND f.is_public = true
      AND f.is_deleted = false
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND NOT v_has_direct_share

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

CREATE OR REPLACE FUNCTION get_page_base_permissions(p_page_id uuid)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_container_owner_id uuid;
BEGIN
  SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by) INTO v_container_owner_id
  FROM pages p WHERE p.id = p_page_id AND p.is_deleted = false;

  RETURN QUERY
  WITH direct_page_users AS (
    SELECT s.recipient_user_id AS user_id
    FROM shares s
    WHERE s.entity_type = 'page' AND s.entity_id = p_page_id
      AND s.token IS NULL AND s.recipient_user_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
  ),
  combined AS (
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
      AND NOT EXISTS (SELECT 1 FROM direct_page_users d WHERE d.user_id = s.recipient_user_id)

    UNION ALL

    SELECT wm.member_id, CASE wm.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' WHEN 'admin' THEN 'admin' END, 4 AS src
    FROM workspace_members wm
    WHERE wm.workspace_owner_id = v_container_owner_id
      AND NOT EXISTS (
        SELECT 1 FROM pages p
        WHERE p.id = p_page_id AND p.is_access_restricted = true AND p.is_deleted = false
      )
      AND NOT EXISTS (
        SELECT 1 FROM folder_closure fc JOIN folders f ON f.id = fc.ancestor_id
        JOIN pages p ON p.id = p_page_id
        WHERE fc.descendant_id = p.parent_id AND f.is_access_restricted = true AND f.is_deleted = false
      )
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

CREATE OR REPLACE FUNCTION get_accessible_page_ids(p_user_id uuid)
RETURNS TABLE(page_id uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH
    shared_folders AS (
      SELECT fc.descendant_id AS id
      FROM shares s JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
      WHERE s.entity_type = 'folder' AND s.recipient_user_id = p_user_id
    ),
    restricted_tree AS (
      SELECT fc.descendant_id AS id
      FROM folders f JOIN folder_closure fc ON fc.ancestor_id = f.id
      WHERE f.is_access_restricted = true AND f.is_deleted = false
    ),
    workspace_owners AS (
      SELECT workspace_owner_id FROM workspace_members WHERE member_id = p_user_id
    ),
    accessible_folders AS (
      SELECT fc.descendant_id AS id
      FROM folders f JOIN folder_closure fc ON fc.ancestor_id = f.id
      WHERE f.is_deleted = false
        AND (get_root_folder_owner(f.id) = p_user_id
          OR f.id IN (SELECT id FROM shared_folders)
          OR (get_root_folder_owner(f.id) IN (SELECT workspace_owner_id FROM workspace_owners)
              AND f.id NOT IN (SELECT id FROM restricted_tree)))
    )
  SELECT p.id FROM pages p
  WHERE p.is_deleted = false
    AND (p.created_by = p_user_id
      OR COALESCE(get_root_folder_owner(p.parent_id), p.created_by) = p_user_id
      OR EXISTS (SELECT 1 FROM shares s WHERE s.entity_type = 'page' AND s.entity_id = p.id AND s.recipient_user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM page_access_events pae WHERE pae.page_id = p.id AND pae.user_id = p_user_id)
      OR p.parent_id IN (SELECT id FROM shared_folders)
      OR (p.is_access_restricted IS NOT TRUE AND p.parent_id IN (SELECT id FROM accessible_folders))
      OR (COALESCE(get_root_folder_owner(p.parent_id), p.created_by) IN (SELECT workspace_owner_id FROM workspace_owners)
          AND p.is_access_restricted IS NOT TRUE
          AND (p.parent_id IS NULL OR p.parent_id NOT IN (SELECT id FROM restricted_tree))));
END;
$$;

COMMIT;
