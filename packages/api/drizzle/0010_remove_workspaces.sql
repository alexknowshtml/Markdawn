-- Migration 0010: Remove workspace concept (drop workspaces and workspace_id columns)
-- WARNING: destructive. Back up your DB before applying.

BEGIN;

-- Drop workspace references on tables that included workspace_id
ALTER TABLE IF EXISTS shares DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS folders DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS pages DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS user_favorites DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS templates DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS connections DROP COLUMN IF EXISTS workspace_id CASCADE;
ALTER TABLE IF EXISTS uploads DROP COLUMN IF EXISTS workspace_id CASCADE;

-- Drop workspace-related tables
DROP TABLE IF EXISTS workspace_members CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;

COMMIT;
