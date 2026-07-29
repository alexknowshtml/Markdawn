CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"org_id" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "invite_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"token_hash" text NOT NULL UNIQUE,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "invite_tokens_role_check" CHECK ("role" in ('owner', 'admin', 'member', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "org_members_pk" UNIQUE("org_id","user_id"),
	CONSTRAINT "org_members_role_check" CHECK ("role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"archived_at" timestamp,
	CONSTRAINT "orgs_slug_format_check" CHECK (char_length("slug") between 1 and 50 and "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
	CONSTRAINT "orgs_slug_reserved_check" CHECK ("slug" not in ('admin', 'api', 'app', 'auth', 'login', 'logout', 'register', 'signup', 'static', 'www'))
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "workspace_memberships_pk" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "workspace_memberships_role_check" CHECK ("role" in ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"visibility" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"archived_at" timestamp,
	CONSTRAINT "workspaces_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "workspaces_slug_format_check" CHECK (char_length("slug") between 1 and 50 and "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
	CONSTRAINT "workspaces_visibility_check" CHECK ("visibility" in ('open', 'private'))
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "system_role" text;--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" ("created_at");--> statement-breakpoint
CREATE INDEX "invite_tokens_email_idx" ON "invite_tokens" ("email");--> statement-breakpoint
CREATE INDEX "invite_tokens_expires_at_idx" ON "invite_tokens" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_tokens_org_email_pending_unique" ON "invite_tokens" ("org_id","email") WHERE "used_at" is null;--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" ("user_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_org_id_orgs_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_invited_by_users_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_orgs_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_orgs_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_system_role_check" CHECK ("system_role" is null or "system_role" = 'super_admin');