-- Unified connections graph: replaces page_links, tags, and page_tags
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" text DEFAULT 'page' NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"target_slug" text NOT NULL,
	"target_label" text NOT NULL,
	"connection_type" text NOT NULL,
	"link_text" text,
	"link_context" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "connections_workspace_source_target_unique" UNIQUE("workspace_id","source_type","source_id","target_type","target_slug","connection_type")
);
--> statement-breakpoint
CREATE TABLE "connection_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"source_block_id" text,
	"position" integer,
	"context" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_source_id_pages_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_occurrences" ADD CONSTRAINT "connection_occurrences_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_source_idx" ON "connections" USING btree ("workspace_id","source_type","source_id","connection_type");--> statement-breakpoint
CREATE INDEX "connections_target_id_idx" ON "connections" USING btree ("workspace_id","target_type","target_id","connection_type");--> statement-breakpoint
CREATE INDEX "connections_target_slug_idx" ON "connections" USING btree ("workspace_id","target_type","target_slug","connection_type");--> statement-breakpoint
CREATE INDEX "connection_occurrences_connection_idx" ON "connection_occurrences" USING btree ("connection_id");--> statement-breakpoint

-- Migrate existing page_links into connections before dropping the old tables.
-- This ensures production data is preserved during the migration.
DO $$
BEGIN
  IF to_regclass('public.page_links') IS NOT NULL THEN
    INSERT INTO connections (id, workspace_id, source_type, source_id, target_type, target_id, target_slug, target_label, connection_type, link_text, occurrence_count, updated_at)
    SELECT gen_random_uuid(), p.workspace_id, 'page', pl.source_page_id, 'page', pl.target_page_id, lower(pl.target_title), pl.target_title, coalesce(pl.link_type, 'wikilink'), pl.link_text, 1, pl.created_at
    FROM page_links pl
    JOIN pages p ON p.id = pl.source_page_id;
  END IF;
END $$;

-- Migrate existing tags + page_tags into connections
DO $$
BEGIN
  IF to_regclass('public.page_tags') IS NOT NULL AND to_regclass('public.tags') IS NOT NULL THEN
    INSERT INTO connections (id, workspace_id, source_type, source_id, target_type, target_id, target_slug, target_label, connection_type, link_text, occurrence_count, updated_at)
    SELECT gen_random_uuid(), t.workspace_id, 'page', pt.page_id, 'tag', NULL, lower(t.name), t.name, 'tag', t.name, 1, t.created_at
    FROM page_tags pt
    JOIN tags t ON t.id = pt.tag_id;
  END IF;
END $$;

-- Drop replaced tables
DROP TABLE IF EXISTS "page_tags" CASCADE;
DROP TABLE IF EXISTS "page_links" CASCADE;
DROP TABLE IF EXISTS "tags" CASCADE;

-- Detach title_search from generated column; add content_search for future full-text
ALTER TABLE "pages" DROP COLUMN IF EXISTS "title_search";
ALTER TABLE "pages" ADD COLUMN "title_search" tsvector;
ALTER TABLE "pages" ADD COLUMN "content_search" text;

-- Backfill title_search for existing pages so they remain searchable
UPDATE pages SET title_search = to_tsvector('english', coalesce(title, '')) WHERE title_search IS NULL;
