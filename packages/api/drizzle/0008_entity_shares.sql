CREATE TABLE "shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "shared_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "recipient_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "recipient_email" text,
  "permission" text NOT NULL DEFAULT 'view',
  "token" text UNIQUE,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX "shares_entity_idx" ON "shares" ("entity_type", "entity_id");
CREATE INDEX "shares_workspace_idx" ON "shares" ("workspace_id");
CREATE INDEX "shares_recipient_idx" ON "shares" ("recipient_user_id");
CREATE INDEX "shares_token_idx" ON "shares" ("token");
