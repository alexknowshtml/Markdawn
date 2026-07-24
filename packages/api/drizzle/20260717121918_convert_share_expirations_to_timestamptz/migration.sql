-- Historical API writes normalized expirations as UTC ISO timestamps. Make
-- that convention explicit while converting legacy timezone-less values so
-- the migration is independent of the deployment session's TimeZone.
ALTER TABLE "shares"
  ALTER COLUMN "expires_at"
  SET DATA TYPE timestamp with time zone
  USING "expires_at" AT TIME ZONE 'UTC';
