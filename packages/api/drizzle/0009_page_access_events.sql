CREATE TABLE "page_access_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "page_id" uuid NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source" text NOT NULL DEFAULT 'link',
  "token" text NOT NULL,
  "permission" text NOT NULL,
  "first_seen_at" timestamp DEFAULT now(),
  "last_seen_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX "page_access_events_page_user_source_token_idx" ON "page_access_events" ("page_id", "user_id", "source", "token");
CREATE INDEX "page_access_events_page_user_idx" ON "page_access_events" ("page_id", "user_id");
CREATE INDEX "page_access_events_token_idx" ON "page_access_events" ("token");
