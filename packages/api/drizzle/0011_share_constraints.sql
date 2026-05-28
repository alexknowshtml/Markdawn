-- Migration 0011: Add FK and UNIQUE constraints to shares table

BEGIN;

ALTER TABLE "shares"
  ADD CONSTRAINT "shares_entity_id_fk"
  FOREIGN KEY ("entity_id") REFERENCES "pages"("id") ON DELETE CASCADE;

ALTER TABLE "shares"
  ADD CONSTRAINT "shares_invite_unique"
  UNIQUE ("entity_type", "entity_id", "recipient_user_id");

COMMIT;
