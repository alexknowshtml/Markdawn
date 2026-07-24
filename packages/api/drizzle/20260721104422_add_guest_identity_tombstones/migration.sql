CREATE TABLE "guest_identity_tombstones" (
	"id" uuid PRIMARY KEY,
	"expired_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "guest_identity_tombstones_expired_at_idx" ON "guest_identity_tombstones" ("expired_at");
