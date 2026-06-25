CREATE OR REPLACE FUNCTION get_accessible_page_ids(p_user_id uuid)
RETURNS TABLE(page_id uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id
  FROM pages p
  JOIN LATERAL get_effective_page_permission(p.id, p_user_id) access ON true
  WHERE p.is_deleted = false
    AND access.permission IS NOT NULL;
END;
$$;
