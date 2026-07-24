create or replace function replace_page_connection_index(
  target_page_id uuid,
  indexed_connections jsonb,
  replaced_connection_types text[] default null
) returns void
language plpgsql
as $$
begin
  delete from connections
  where source_type = 'page'
    and source_id = target_page_id
    and (
      replaced_connection_types is null
      or connection_type = any(replaced_connection_types)
    );

  with input as materialized (
    select gen_random_uuid() as id, connection.*
    from jsonb_to_recordset(coalesce(indexed_connections, '[]'::jsonb)) as connection(
      "targetType" text,
      "targetId" uuid,
      "targetSlug" text,
      "targetLabel" text,
      "connectionType" text,
      "linkText" text,
      "linkContext" text,
      "occurrenceCount" integer,
      occurrences jsonb
    )
  ), inserted as (
    insert into connections (
      id, source_type, source_id, target_type, target_id, target_slug,
      target_label, connection_type, link_text, link_context,
      occurrence_count, updated_at
    )
    select
      id,
      'page',
      target_page_id,
      "targetType",
      "targetId",
      "targetSlug",
      "targetLabel",
      "connectionType",
      "linkText",
      "linkContext",
      "occurrenceCount",
      now()
    from input
    returning id
  )
  insert into connection_occurrences (connection_id, context)
  select input.id, occurrence.context
  from input
  join inserted on inserted.id = input.id
  cross join lateral jsonb_to_recordset(coalesce(input.occurrences, '[]'::jsonb))
    as occurrence(context text);
end;
$$;
