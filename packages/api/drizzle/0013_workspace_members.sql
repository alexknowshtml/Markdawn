-- Migration 0013: Add workspace membership, expiration, and restricted folders

BEGIN;

-- Workspace members: each user has a single workspace; members can access the owner's content
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(workspace_owner_id, member_id)
);

-- Expiration on shares (for time-limited access)
ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS shares_expires_at_idx ON shares(expires_at) WHERE expires_at IS NOT NULL;

-- Restricted folder flag: workspace members cannot access content inside a restricted folder
-- unless they have a direct invite on that folder or its ancestors
ALTER TABLE folders ADD COLUMN IF NOT EXISTS is_access_restricted BOOLEAN DEFAULT FALSE;

COMMIT;
