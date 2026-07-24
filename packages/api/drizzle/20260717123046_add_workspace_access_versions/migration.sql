CREATE TABLE "workspace_access_versions" (
	"workspace_owner_id" uuid PRIMARY KEY,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_access_versions" ADD CONSTRAINT "workspace_access_versions_workspace_owner_id_users_id_fkey" FOREIGN KEY ("workspace_owner_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE SEQUENCE "workspace_access_revision_seq" AS bigint;
--> statement-breakpoint
INSERT INTO "workspace_access_versions" ("workspace_owner_id", "version")
SELECT "id", 0 FROM "users"
ON CONFLICT ("workspace_owner_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION get_page_access_revision(p_page_id uuid)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT wav.version
      FROM pages p
      LEFT JOIN workspace_access_versions wav
        ON wav.workspace_owner_id = COALESCE(
          (
            SELECT root.created_by
            FROM folder_closure fc
            JOIN folders root ON root.id = fc.ancestor_id
            WHERE fc.descendant_id = p.parent_id
              AND root.parent_id IS NULL
            ORDER BY fc.depth DESC
            LIMIT 1
          ),
          p.created_by
        )
      WHERE p.id = p_page_id
    ),
    (SELECT MAX(version) FROM workspace_access_versions),
    0
  );
$$;
