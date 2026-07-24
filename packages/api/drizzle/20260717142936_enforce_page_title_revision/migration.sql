CREATE OR REPLACE FUNCTION "enforce_page_title_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."title" IS DISTINCT FROM OLD."title" THEN
    IF NEW."title_revision" IS NULL OR NEW."title_revision" <= OLD."title_revision" THEN
      NEW."title_revision" := OLD."title_revision" + 1;
    END IF;
  ELSIF NEW."title_revision" IS NULL OR NEW."title_revision" < OLD."title_revision" THEN
    NEW."title_revision" := OLD."title_revision";
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "pages_enforce_title_revision" ON "pages";

CREATE TRIGGER "pages_enforce_title_revision"
BEFORE UPDATE OF "title", "title_revision" ON "pages"
FOR EACH ROW
EXECUTE FUNCTION "enforce_page_title_revision"();
