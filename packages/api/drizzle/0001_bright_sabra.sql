CREATE TABLE "accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
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
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid,
	"user_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid,
	"user_id" uuid,
	"content" text NOT NULL,
	"anchor_block_id" text,
	"resolved" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid,
	"content" jsonb NOT NULL,
	"title" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "page_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"page_id" uuid,
	"visited_at" timestamp DEFAULT now(),
	CONSTRAINT "page_visits_user_id_page_id_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"expires_at" timestamp,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"title" text NOT NULL,
	"icon" text,
	"description" text,
	"content_blocks" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"page_id" uuid,
	"workspace_id" uuid,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "user_favorites_user_id_page_id_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "position" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "position" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "title_search" text GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "cover_type" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "cover_value" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "is_public" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "is_deleted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_replies" ADD CONSTRAINT "comment_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_public_token_unique" UNIQUE("public_token");