UPDATE "page_access_events" event
SET "permission" = 'edit'
FROM "shares" share
WHERE share."entity_type" = 'page'
  AND share."entity_id" = event."page_id"
  AND share."token" = event."token"
  AND share."token" IS NOT NULL
  AND share."permission" = 'admin';
--> statement-breakpoint
UPDATE "folder_access_events" event
SET "permission" = 'edit'
FROM "shares" share
WHERE share."entity_type" = 'folder'
  AND share."entity_id" = event."folder_id"
  AND share."token" = event."token"
  AND share."token" IS NOT NULL
  AND share."permission" = 'admin';
--> statement-breakpoint
UPDATE "shares"
SET "permission" = 'edit', "updated_at" = now()
WHERE "token" IS NOT NULL AND "permission" = 'admin';
--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_public_link_permission_check" CHECK ("token" is null or "permission" in ('view', 'edit'));
