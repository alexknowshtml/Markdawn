UPDATE "folders" SET "position" = btrim("position");--> statement-breakpoint
UPDATE "folders" SET "position" = '0'
WHERE char_length("position") > 128
   OR "position" !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$';--> statement-breakpoint
UPDATE "pages" SET "position" = btrim("position");--> statement-breakpoint
UPDATE "pages" SET "position" = '0'
WHERE char_length("position") > 128
   OR "position" !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$';--> statement-breakpoint
WITH ranked_links AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY entity_type, entity_id
           ORDER BY CASE permission WHEN 'admin' THEN 3 WHEN 'edit' THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST,
                    id
         ) AS row_number
  FROM shares
  WHERE token IS NOT NULL
)
DELETE FROM shares
WHERE id IN (SELECT id FROM ranked_links WHERE row_number > 1);--> statement-breakpoint
UPDATE pages p
SET public_token = s.token
FROM shares s
WHERE p.id = s.entity_id
  AND s.entity_type = 'page'
  AND s.token IS NOT NULL
  AND p.is_public = true;--> statement-breakpoint
UPDATE folders f
SET public_token = s.token
FROM shares s
WHERE f.id = s.entity_id
  AND s.entity_type = 'folder'
  AND s.token IS NOT NULL
  AND f.is_public = true;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_link_unique" ON "shares" ("entity_type","entity_id") WHERE "token" is not null;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_position_numeric_check" CHECK (char_length("position") <= 128 AND "position" ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$');--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_position_numeric_check" CHECK (char_length("position") <= 128 AND "position" ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$');