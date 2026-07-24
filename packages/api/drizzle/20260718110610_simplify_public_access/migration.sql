DROP FUNCTION IF EXISTS get_effective_page_permission(uuid, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_effective_folder_permission(uuid, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_page_base_permissions(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_accessible_page_ids(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_enumerable_folder_ids(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_effective_page_permission_at(uuid, uuid, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_effective_folder_permission_at(uuid, uuid, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_page_base_permissions_at(uuid, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_accessible_page_ids_at(uuid, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS get_enumerable_folder_ids_at(uuid, timestamptz);--> statement-breakpoint

CREATE TABLE "guest_identities" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folder_access_events" RENAME TO "folder_public_access_visits";--> statement-breakpoint
ALTER TABLE "page_access_events" RENAME TO "page_public_access_visits";--> statement-breakpoint
ALTER TABLE "folder_public_access_visits" DROP CONSTRAINT "folder_access_events_folder_id_user_id_source_token_unique";--> statement-breakpoint
ALTER TABLE "page_public_access_visits" DROP CONSTRAINT "page_access_events_page_id_user_id_source_token_unique";--> statement-breakpoint
ALTER TABLE "shares" DROP CONSTRAINT "shares_token_key";--> statement-breakpoint
ALTER TABLE "pages" DROP CONSTRAINT "pages_public_token_key";--> statement-breakpoint
ALTER TABLE "shares" DROP CONSTRAINT "shares_public_link_permission_check";--> statement-breakpoint
ALTER INDEX "folder_access_events_folder_user_idx" RENAME TO "folder_public_access_visits_user_idx";--> statement-breakpoint
ALTER INDEX "page_access_events_page_user_idx" RENAME TO "page_public_access_visits_user_idx";--> statement-breakpoint
DROP INDEX "folder_access_events_token_idx";--> statement-breakpoint
DROP INDEX "page_access_events_token_idx";--> statement-breakpoint
DROP INDEX "shares_token_idx";--> statement-breakpoint
DROP INDEX "shares_expires_at_idx";--> statement-breakpoint
DROP INDEX "shares_link_unique";--> statement-breakpoint
ALTER TABLE "comment_replies" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "public_permission" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "public_permission" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "uploaded_by_guest_id" uuid;--> statement-breakpoint
TRUNCATE TABLE "folder_public_access_visits", "page_public_access_visits";--> statement-breakpoint
DELETE FROM "shares" WHERE "recipient_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN "is_public";--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN "public_token";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "is_public";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "public_token";--> statement-breakpoint
ALTER TABLE "folder_public_access_visits" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "folder_public_access_visits" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "folder_public_access_visits" DROP COLUMN "permission";--> statement-breakpoint
ALTER TABLE "page_public_access_visits" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "page_public_access_visits" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "page_public_access_visits" DROP COLUMN "permission";--> statement-breakpoint
ALTER TABLE "shares" DROP COLUMN "recipient_email";--> statement-breakpoint
ALTER TABLE "shares" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "shares" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "recipient_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "uploaded_by" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "folder_public_access_visits_user_idx";--> statement-breakpoint
CREATE INDEX "folder_public_access_visits_user_idx" ON "folder_public_access_visits" ("user_id");--> statement-breakpoint
DROP INDEX "page_public_access_visits_user_idx";--> statement-breakpoint
CREATE INDEX "page_public_access_visits_user_idx" ON "page_public_access_visits" ("user_id");--> statement-breakpoint
ALTER TABLE "shares" RENAME CONSTRAINT "shares_invite_unique" TO "shares_recipient_unique";--> statement-breakpoint
ALTER TABLE "folder_public_access_visits" ADD CONSTRAINT "folder_public_access_visits_folder_user_unique" UNIQUE("folder_id","user_id");--> statement-breakpoint
ALTER TABLE "page_public_access_visits" ADD CONSTRAINT "page_public_access_visits_page_user_unique" UNIQUE("page_id","user_id");--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_guest_id_guest_identities_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guest_identities"("id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_guest_id_guest_identities_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guest_identities"("id");--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploaded_by_guest_id_guest_identities_id_fkey" FOREIGN KEY ("uploaded_by_guest_id") REFERENCES "guest_identities"("id");--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_author_check" CHECK (num_nonnulls("user_id", "guest_id") = 1);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_check" CHECK (num_nonnulls("user_id", "guest_id") = 1);--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_public_permission_check" CHECK ("public_permission" is null or "public_permission" in ('view', 'edit'));--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_public_permission_check" CHECK ("public_permission" is null or "public_permission" in ('view', 'edit'));--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_check" CHECK (num_nonnulls("uploaded_by", "uploaded_by_guest_id") = 1);--> statement-breakpoint

CREATE FUNCTION get_public_folder_permission(p_folder_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $function$
  SELECT candidate.permission
  FROM (
    SELECT source.public_permission AS permission, path.depth
    FROM folder_closure path
    JOIN folders source ON source.id = path.ancestor_id
    JOIN folders target ON target.id = path.descendant_id
    WHERE path.descendant_id = p_folder_id
      AND source.is_deleted = false
      AND target.is_deleted = false
      AND source.public_permission IS NOT NULL
      AND (
        source.id = target.id
        OR NOT is_folder_inheritance_blocked(source.id, target.id)
      )
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.depth ASC
  LIMIT 1;
$function$;--> statement-breakpoint

CREATE FUNCTION get_public_page_permission(p_page_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $function$
  WITH target AS (
    SELECT id, parent_id, public_permission
    FROM pages
    WHERE id = p_page_id AND is_deleted = false
  ), candidates AS (
    SELECT target.public_permission AS permission, 0 AS depth
    FROM target
    WHERE target.public_permission IS NOT NULL

    UNION ALL

    SELECT source.public_permission, path.depth + 1
    FROM target
    JOIN folder_closure path ON path.descendant_id = target.parent_id
    JOIN folders source ON source.id = path.ancestor_id
    WHERE source.is_deleted = false
      AND source.public_permission IS NOT NULL
      AND NOT is_page_folder_inheritance_blocked(source.id, p_page_id)
  )
  SELECT candidates.permission
  FROM candidates
  ORDER BY CASE candidates.permission WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidates.depth ASC
  LIMIT 1;
$function$;--> statement-breakpoint

CREATE FUNCTION get_effective_page_permission(
  p_page_id uuid,
  p_user_id uuid
)
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

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'edit'::text, true;
    RETURN;
  END IF;

  SELECT candidate.permission
  INTO v_result
  FROM (
    SELECT share.permission, 1 AS source_rank
    FROM shares share
    WHERE share.entity_type = 'page'
      AND share.entity_id = p_page_id
      AND share.recipient_user_id = p_user_id

    UNION ALL

    SELECT share.permission, 2
    FROM shares share
    JOIN folders source ON source.id = share.entity_id
    WHERE share.entity_type = 'folder'
      AND share.recipient_user_id = p_user_id
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
    END, 3
    FROM workspace_members member
    WHERE member.workspace_owner_id = v_owner_id
      AND member.member_id = p_user_id
      AND NOT is_page_path_restricted(p_page_id)

    UNION ALL

    SELECT get_public_page_permission(p_page_id), 4
    WHERE get_public_page_permission(p_page_id) IS NOT NULL
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;

  RETURN QUERY SELECT v_result, false;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION get_effective_folder_permission(
  p_folder_id uuid,
  p_user_id uuid
)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_result text;
BEGIN
  SELECT get_root_folder_owner(p_folder_id)
  INTO v_owner_id
  WHERE EXISTS (
    SELECT 1 FROM folders WHERE id = p_folder_id AND is_deleted = false
  );

  IF v_owner_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN QUERY SELECT 'admin'::text, true;
    RETURN;
  END IF;

  SELECT candidate.permission
  INTO v_result
  FROM (
    SELECT share.permission, 1 AS source_rank
    FROM shares share
    WHERE share.entity_type = 'folder'
      AND share.entity_id = p_folder_id
      AND share.recipient_user_id = p_user_id

    UNION ALL

    SELECT share.permission, 2
    FROM shares share
    JOIN folders source ON source.id = share.entity_id
    WHERE share.entity_type = 'folder'
      AND share.recipient_user_id = p_user_id
      AND source.is_deleted = false
      AND share.entity_id IN (
        SELECT ancestor_id
        FROM folder_closure
        WHERE descendant_id = p_folder_id AND ancestor_id <> p_folder_id
      )
      AND NOT is_folder_inheritance_blocked(share.entity_id, p_folder_id)

    UNION ALL

    SELECT CASE member.role
      WHEN 'viewer' THEN 'view'
      WHEN 'editor' THEN 'edit'
      WHEN 'admin' THEN 'admin'
    END, 3
    FROM workspace_members member
    WHERE member.workspace_owner_id = v_owner_id
      AND member.member_id = p_user_id
      AND NOT is_folder_path_restricted(p_folder_id)

    UNION ALL

    SELECT get_public_folder_permission(p_folder_id), 4
    WHERE get_public_folder_permission(p_folder_id) IS NOT NULL
  ) candidate
  ORDER BY CASE candidate.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
           candidate.source_rank ASC
  LIMIT 1;

  RETURN QUERY SELECT v_result, false;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION get_page_base_permissions(p_page_id uuid)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_owner_id uuid;
  v_parent_id uuid;
BEGIN
  SELECT COALESCE(get_root_folder_owner(page.parent_id), page.created_by), page.parent_id
  INTO v_owner_id, v_parent_id
  FROM pages page
  WHERE page.id = p_page_id AND page.is_deleted = false;

  RETURN QUERY
  WITH combined AS (
    SELECT share.recipient_user_id AS user_id, share.permission, 1 AS source_rank
    FROM shares share
    WHERE share.entity_type = 'page' AND share.entity_id = p_page_id

    UNION ALL

    SELECT share.recipient_user_id, share.permission, 2
    FROM shares share
    JOIN folders source ON source.id = share.entity_id
    WHERE share.entity_type = 'folder'
      AND source.is_deleted = false
      AND share.entity_id IN (
        SELECT ancestor_id FROM folder_closure WHERE descendant_id = v_parent_id
      )
      AND NOT is_page_folder_inheritance_blocked(share.entity_id, p_page_id)

    UNION ALL

    SELECT member.member_id,
      CASE member.role WHEN 'viewer' THEN 'view' WHEN 'editor' THEN 'edit' ELSE 'admin' END,
      3
    FROM workspace_members member
    WHERE member.workspace_owner_id = v_owner_id
      AND NOT is_page_path_restricted(p_page_id)
  ), ranked AS (
    SELECT DISTINCT ON (combined.user_id) combined.user_id, combined.permission
    FROM combined
    ORDER BY combined.user_id,
      CASE combined.permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
      combined.source_rank ASC
  )
  SELECT v_owner_id, 'edit'::text WHERE v_owner_id IS NOT NULL
  UNION
  SELECT ranked.user_id, ranked.permission FROM ranked;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION get_accessible_page_ids(p_user_id uuid)
RETURNS TABLE(page_id uuid)
LANGUAGE sql STABLE
AS $function$
  SELECT page.id
  FROM pages page
  WHERE page.is_deleted = false
    AND (
      EXISTS (
        SELECT 1
        FROM get_page_base_permissions(page.id) account_access
        WHERE account_access.user_id = p_user_id
      )
      OR (
        get_public_page_permission(page.id) IS NOT NULL
        AND (
          EXISTS (
            SELECT 1
            FROM page_public_access_visits visit
            WHERE visit.page_id = page.id AND visit.user_id = p_user_id
          )
          OR EXISTS (
            SELECT 1
            FROM folder_public_access_visits visit
            JOIN folder_closure path ON path.ancestor_id = visit.folder_id
            WHERE visit.user_id = p_user_id
              AND path.descendant_id = page.parent_id
              AND NOT is_page_folder_inheritance_blocked(visit.folder_id, page.id)
          )
        )
      )
    );
$function$;--> statement-breakpoint

CREATE FUNCTION get_enumerable_folder_ids(p_user_id uuid)
RETURNS TABLE(folder_id uuid)
LANGUAGE sql STABLE
AS $function$
  WITH enumerable AS (
    SELECT folder.id AS folder_id
    FROM folders folder
    WHERE folder.is_deleted = false AND get_root_folder_owner(folder.id) = p_user_id

    UNION

    SELECT target.id
    FROM folders target
    JOIN folder_closure path ON path.descendant_id = target.id
    JOIN folders source ON source.id = path.ancestor_id
    JOIN shares share ON share.entity_type = 'folder' AND share.entity_id = source.id
    WHERE share.recipient_user_id = p_user_id
      AND source.is_deleted = false
      AND target.is_deleted = false
      AND (source.id = target.id OR NOT is_folder_inheritance_blocked(source.id, target.id))

    UNION

    SELECT folder.id
    FROM folders folder
    JOIN workspace_members member
      ON member.workspace_owner_id = get_root_folder_owner(folder.id)
     AND member.member_id = p_user_id
    WHERE folder.is_deleted = false AND NOT is_folder_path_restricted(folder.id)

    UNION

    SELECT target.id
    FROM folder_public_access_visits visit
    JOIN folders source ON source.id = visit.folder_id
    JOIN folder_closure path ON path.ancestor_id = source.id
    JOIN folders target ON target.id = path.descendant_id
    WHERE visit.user_id = p_user_id
      AND source.is_deleted = false
      AND target.is_deleted = false
      AND get_public_folder_permission(source.id) IS NOT NULL
      AND (source.id = target.id OR NOT is_folder_inheritance_blocked(source.id, target.id))
  )
  SELECT folder_id FROM enumerable;
$function$;
