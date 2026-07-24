CREATE OR REPLACE FUNCTION get_effective_page_permission(p_page_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM get_effective_page_permission_at(p_page_id, p_user_id, statement_timestamp());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_effective_folder_permission(p_folder_id uuid, p_user_id uuid)
RETURNS TABLE(permission text, full_access boolean)
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM get_effective_folder_permission_at(p_folder_id, p_user_id, statement_timestamp());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_page_base_permissions(p_page_id uuid)
RETURNS TABLE(user_id uuid, permission text)
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM get_page_base_permissions_at(p_page_id, statement_timestamp());
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_accessible_page_ids(p_user_id uuid)
RETURNS TABLE(page_id uuid)
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM get_accessible_page_ids_at(p_user_id, statement_timestamp());
$$;
