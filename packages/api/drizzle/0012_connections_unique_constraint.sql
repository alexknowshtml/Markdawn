-- Migration 0012: Recreate connections unique constraint (without workspace_id)
-- The constraint was dropped when workspace_id was removed in 0010

ALTER TABLE connections
  ADD CONSTRAINT connections_source_target_unique
  UNIQUE (source_type, source_id, target_type, target_slug, connection_type);
