CREATE TABLE "accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"comment_id" uuid,
	"user_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"page_id" uuid,
	"user_id" uuid,
	"content" text NOT NULL,
	"anchor_block_id" text,
	"resolved" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "connection_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"connection_id" uuid NOT NULL,
	"source_block_id" text,
	"position" integer,
	"context" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
	CONSTRAINT "connections_source_type_source_id_target_type_target_slug_connection_type_unique" UNIQUE("source_type","source_id","target_type","target_slug","connection_type")
);
--> statement-breakpoint
CREATE TABLE "folder_closure" (
	"ancestor_id" uuid NOT NULL,
	"descendant_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "folder_closure_pk" UNIQUE("ancestor_id","descendant_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"parent_id" uuid,
	"name" text DEFAULT 'New Folder' NOT NULL,
	"icon" text,
	"position" text DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp,
	"is_public" boolean DEFAULT false,
	"public_token" text,
	"inheritance_policy" text DEFAULT 'inherit' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"page_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'link' NOT NULL,
	"token" text NOT NULL,
	"permission" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	CONSTRAINT "page_access_events_page_id_user_id_source_token_unique" UNIQUE("page_id","user_id","source","token")
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"page_id" uuid,
	"content" jsonb NOT NULL,
	"title" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "page_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"page_id" uuid,
	"visited_at" timestamp DEFAULT now(),
	CONSTRAINT "page_visits_user_id_page_id_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"parent_id" uuid,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"title_search" tsvector,
	"content_search" text,
	"icon" text,
	"cover_type" text,
	"cover_value" text,
	"position" text DEFAULT '0' NOT NULL,
	"ydoc" bytea,
	"properties" jsonb,
	"created_by" uuid,
	"is_public" boolean DEFAULT false,
	"public_token" text UNIQUE,
	"inheritance_policy" text DEFAULT 'inherit' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"expires_at" timestamp,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"shared_by" uuid,
	"recipient_user_id" uuid,
	"recipient_email" text,
	"permission" text DEFAULT 'view' NOT NULL,
	"token" text UNIQUE,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "shares_invite_unique" UNIQUE("entity_type","entity_id","recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"title" text NOT NULL,
	"icon" text,
	"description" text,
	"content_blocks" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "upload_page_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"upload_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "upload_page_refs_upload_page_unique" UNIQUE("upload_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"filename" text NOT NULL UNIQUE,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"page_id" uuid,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "user_favorites_user_id_page_id_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"email_verified" boolean DEFAULT false,
	"image" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_owner_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "workspace_members_owner_member_unique" UNIQUE("workspace_owner_id","member_id")
);
--> statement-breakpoint
CREATE INDEX "connection_occurrences_connection_idx" ON "connection_occurrences" ("connection_id");--> statement-breakpoint
CREATE INDEX "connections_source_idx" ON "connections" ("source_type","source_id","connection_type");--> statement-breakpoint
CREATE INDEX "connections_target_id_idx" ON "connections" ("target_type","target_id","connection_type");--> statement-breakpoint
CREATE INDEX "connections_target_slug_idx" ON "connections" ("target_type","target_slug","connection_type");--> statement-breakpoint
CREATE INDEX "folder_closure_descendant_idx" ON "folder_closure" ("descendant_id");--> statement-breakpoint
CREATE INDEX "folder_closure_ancestor_idx" ON "folder_closure" ("ancestor_id");--> statement-breakpoint
CREATE INDEX "page_access_events_page_user_idx" ON "page_access_events" ("page_id","user_id");--> statement-breakpoint
CREATE INDEX "page_access_events_token_idx" ON "page_access_events" ("token");--> statement-breakpoint
CREATE INDEX "pages_title_search_idx" ON "pages" USING gin ("title_search");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "sessions" ("token");--> statement-breakpoint
CREATE INDEX "shares_entity_idx" ON "shares" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "shares_recipient_idx" ON "shares" ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "shares_token_idx" ON "shares" ("token");--> statement-breakpoint
CREATE INDEX "shares_expires_at_idx" ON "shares" ("expires_at");--> statement-breakpoint
CREATE INDEX "upload_page_refs_upload_idx" ON "upload_page_refs" ("upload_id");--> statement-breakpoint
CREATE INDEX "upload_page_refs_page_idx" ON "upload_page_refs" ("page_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_comment_id_comments_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection_occurrences" ADD CONSTRAINT "connection_occurrences_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_source_id_pages_id_fkey" FOREIGN KEY ("source_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folder_closure" ADD CONSTRAINT "folder_closure_ancestor_id_folders_id_fkey" FOREIGN KEY ("ancestor_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folder_closure" ADD CONSTRAINT "folder_closure_descendant_id_folders_id_fkey" FOREIGN KEY ("descendant_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "page_access_events" ADD CONSTRAINT "page_access_events_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_access_events" ADD CONSTRAINT "page_access_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_folders_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_shared_by_users_id_fkey" FOREIGN KEY ("shared_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_recipient_user_id_users_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "upload_page_refs" ADD CONSTRAINT "upload_page_refs_upload_id_uploads_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upload_page_refs" ADD CONSTRAINT "upload_page_refs_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploaded_by_users_id_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_owner_id_users_id_fkey" FOREIGN KEY ("workspace_owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_member_id_users_id_fkey" FOREIGN KEY ("member_id") REFERENCES "users"("id") ON DELETE CASCADE;