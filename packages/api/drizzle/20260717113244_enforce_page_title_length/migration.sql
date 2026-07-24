UPDATE "pages"
SET "title" = left("title", 250),
    "title_search" = to_tsvector('english', left("title", 250)),
    "updated_at" = now()
WHERE char_length("title") > 250;
--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_title_length_check" CHECK (char_length("title") <= 250);
