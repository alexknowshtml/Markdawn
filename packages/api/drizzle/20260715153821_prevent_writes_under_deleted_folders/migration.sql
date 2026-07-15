CREATE OR REPLACE FUNCTION ensure_active_folder_parent()
RETURNS trigger AS $trg$
DECLARE
  parent_is_deleted boolean;
BEGIN
  IF NEW.parent_id IS NULL OR NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  SELECT is_deleted
  INTO parent_is_deleted
  FROM folders
  WHERE id = NEW.parent_id
  FOR SHARE;

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
BEFORE INSERT OR UPDATE ON folders
FOR EACH ROW EXECUTE FUNCTION ensure_active_folder_parent();
--> statement-breakpoint

CREATE TRIGGER pages_active_parent_trigger
BEFORE INSERT OR UPDATE ON pages
FOR EACH ROW EXECUTE FUNCTION ensure_active_folder_parent();
