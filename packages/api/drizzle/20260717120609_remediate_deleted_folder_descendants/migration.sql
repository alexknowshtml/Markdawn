-- Older databases could contain active descendants below a folder that had
-- already been moved to Trash. The active-parent triggers prevent new rows
-- from being placed there, but they cannot repair state that predates those
-- triggers. Carry the nearest deleted ancestor's deletion identity through
-- the subtree so restore and permanent-delete continue to operate on one
-- coherent batch.
WITH nearest_deleted_ancestor AS (
  SELECT DISTINCT ON (descendant.id)
    descendant.id AS descendant_id,
    ancestor.deleted_at,
    ancestor.deletion_batch_id
  FROM folders descendant
  JOIN folder_closure path
    ON path.descendant_id = descendant.id
   AND path.depth > 0
  JOIN folders ancestor
    ON ancestor.id = path.ancestor_id
   AND ancestor.is_deleted = true
  WHERE descendant.is_deleted = false
  ORDER BY descendant.id, path.depth ASC
)
UPDATE folders descendant
SET is_deleted = true,
    deleted_at = COALESCE(nearest.deleted_at, now()),
    deletion_batch_id = nearest.deletion_batch_id,
    updated_at = now()
FROM nearest_deleted_ancestor nearest
WHERE descendant.id = nearest.descendant_id;
--> statement-breakpoint

WITH nearest_deleted_ancestor AS (
  SELECT DISTINCT ON (page.id)
    page.id AS page_id,
    ancestor.deleted_at,
    ancestor.deletion_batch_id
  FROM pages page
  JOIN folder_closure path
    ON path.descendant_id = page.parent_id
  JOIN folders ancestor
    ON ancestor.id = path.ancestor_id
   AND ancestor.is_deleted = true
  WHERE page.is_deleted = false
  ORDER BY page.id, path.depth ASC
)
UPDATE pages page
SET is_deleted = true,
    deleted_at = COALESCE(nearest.deleted_at, now()),
    deletion_batch_id = nearest.deletion_batch_id,
    updated_at = now()
FROM nearest_deleted_ancestor nearest
WHERE page.id = nearest.page_id;
