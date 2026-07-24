CREATE TABLE "folder_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"folder_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'link' NOT NULL,
	"token" text NOT NULL,
	"permission" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	CONSTRAINT "folder_access_events_folder_id_user_id_source_token_unique" UNIQUE("folder_id","user_id","source","token")
);
--> statement-breakpoint
ALTER TABLE "user_favorites" DROP CONSTRAINT "user_favorites_page_id_pages_id_fkey";--> statement-breakpoint
ALTER TABLE "user_favorites" DROP CONSTRAINT "user_favorites_user_id_page_id_unique";--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "entity_type" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
UPDATE "user_favorites" SET "entity_id" = "page_id" WHERE "entity_id" IS NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" DROP COLUMN "page_id";--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_entity_type_entity_id_unique" UNIQUE("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "folder_access_events_folder_user_idx" ON "folder_access_events" ("folder_id","user_id");--> statement-breakpoint
CREATE INDEX "folder_access_events_token_idx" ON "folder_access_events" ("token");--> statement-breakpoint
CREATE INDEX "user_favorites_entity_idx" ON "user_favorites" ("entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "folder_access_events" ADD CONSTRAINT "folder_access_events_folder_id_folders_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folder_access_events" ADD CONSTRAINT "folder_access_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folder_access_events" ADD CONSTRAINT "folder_access_events_permission_check" CHECK ("permission" IN ('view', 'edit', 'admin'));--> statement-breakpoint
ALTER TABLE "folder_access_events" ADD CONSTRAINT "folder_access_events_source_check" CHECK ("source" = 'link');--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_entity_type_check" CHECK ("entity_type" IN ('page', 'folder'));--> statement-breakpoint
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
          AND (s.expires_at IS NULL OR s.expires_at > NOW())

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
          AND (s.expires_at IS NULL OR s.expires_at > NOW())
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
