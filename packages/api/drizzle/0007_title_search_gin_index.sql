-- Add GIN index on title_search for full-text search performance.
-- Without this index, every text search does a sequential scan on pages.
CREATE INDEX IF NOT EXISTS "pages_title_search_idx" ON "pages" USING GIN ("title_search");
