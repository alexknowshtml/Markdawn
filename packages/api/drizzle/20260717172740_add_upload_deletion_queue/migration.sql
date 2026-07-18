CREATE TABLE "upload_deletion_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"filename" text NOT NULL UNIQUE,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "upload_deletion_queue_updated_at_id_idx" ON "upload_deletion_queue" ("updated_at","id");