-- Drop page_renames table — renames are now handled by direct pg_notify
-- to the collab server, which pushes the new title into the meta room and
-- any active in-memory Yjs session. The SQL pages.title column is the
-- authoritative cache; the Yjs doc is the single source of truth.
DROP TABLE IF EXISTS "page_renames" CASCADE;
