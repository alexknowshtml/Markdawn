CREATE FUNCTION establish_guest_identity(guest_id uuid, guest_name text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('guest-identity:' || guest_id::text, 0));
	IF EXISTS (SELECT 1 FROM guest_identity_tombstones WHERE id = guest_id) THEN
		RETURN false;
	END IF;

	INSERT INTO guest_identities (id, name, created_at, last_seen_at)
	VALUES (guest_id, guest_name, now(), now())
	ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at;
	RETURN true;
END;
$$;
