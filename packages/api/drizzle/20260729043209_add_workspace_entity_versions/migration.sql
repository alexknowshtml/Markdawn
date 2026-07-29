CREATE TABLE "workspace_entity_versions" (
	"workspace_id" uuid PRIMARY KEY,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_entity_versions" ADD CONSTRAINT "workspace_entity_versions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE SEQUENCE "workspace_entity_revision_seq" AS bigint;
--> statement-breakpoint
INSERT INTO "workspace_entity_versions" ("workspace_id", "version")
SELECT "id", 0 FROM "workspaces"
ON CONFLICT ("workspace_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION get_page_access_revision(p_page_id uuid)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT wev.version
      FROM pages p
      JOIN workspace_entity_versions wev ON wev.workspace_id = p.workspace_id
      WHERE p.id = p_page_id AND p.workspace_id IS NOT NULL
    ),
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