CREATE OR REPLACE FUNCTION ensure_active_folder_parent()
RETURNS trigger AS $trg$
DECLARE
  parent_is_deleted boolean;
  old_parent_id uuid := NULL;
BEGIN
  IF NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_parent_id := OLD.parent_id;
  END IF;

  -- Lock both sides of a move in deterministic order. Recursive deletion
  -- locks the subtree's folder rows FOR UPDATE, so concurrent inserts,
  -- restores, and moves wait and then re-check that their destination is
  -- still active without blocking writes in unrelated workspaces.
  PERFORM id
  FROM folders
  WHERE id = NEW.parent_id OR id = old_parent_id
  ORDER BY id
  FOR SHARE;

  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_deleted
  INTO parent_is_deleted
  FROM folders
  WHERE id = NEW.parent_id;

  -- Let the existing foreign key report a missing parent.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF parent_is_deleted THEN
    RAISE EXCEPTION 'Cannot place content inside a deleted folder'
      USING ERRCODE = '23514', CONSTRAINT = 'active_folder_parent';
  END IF;

  RETURN NEW;
END;
$trg$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER folders_active_parent_trigger
BEFORE INSERT OR UPDATE OF parent_id, is_deleted ON folders
FOR EACH ROW EXECUTE FUNCTION ensure_active_folder_parent();
--> statement-breakpoint

CREATE TRIGGER pages_active_parent_trigger
BEFORE INSERT OR UPDATE OF parent_id, is_deleted ON pages
FOR EACH ROW EXECUTE FUNCTION ensure_active_folder_parent();
