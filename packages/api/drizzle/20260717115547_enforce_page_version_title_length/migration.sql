UPDATE "page_versions"
SET "title" = left("title", 250)
WHERE char_length("title") > 250;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_title_length_check" CHECK ("title" is null or char_length("title") <= 250);
