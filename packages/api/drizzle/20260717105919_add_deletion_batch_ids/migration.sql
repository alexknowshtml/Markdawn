ALTER TABLE "folders" ADD COLUMN "deletion_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deletion_batch_id" uuid;