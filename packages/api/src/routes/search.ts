import { type SQL, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';

type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  breadcrumb: string[] | null;
};

const searchRoute = new Hono();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

searchRoute.use('*', requireAuth);

function parseTagSearch(query: string): { textQuery: string; tagSlugs: string[] } {
  const tagMatch = query.match(/(?:^|\s)tags:\s*(.+)$/i);
  if (!tagMatch) {
    return { textQuery: query, tagSlugs: [] };
  }

  const tagPart = tagMatch[1] ?? '';
  const textQuery = query.slice(0, tagMatch.index).trim();
  const tagSlugs = tagPart
    .split(',')
    .map((tag) => tag.trim().replace(/^#+/, '').toLowerCase())
    .filter(Boolean)
    .map((tag) => `#${tag}`);

  return { textQuery, tagSlugs: [...new Set(tagSlugs)] };
}

searchRoute.get('/', async (c) => {
  const rawQuery = c.req.query('q')?.trim() ?? '';
  if (!rawQuery) {
    return c.json({ results: [] });
  }

  const user = c.get('user') as { id: string };
  const { textQuery, tagSlugs } = parseTagSearch(rawQuery);
  const createdAfter = c.req.query('createdAfter');
  const createdBefore = c.req.query('createdBefore');
  const parentId = c.req.query('parentId');
  if (parentId && parentId !== 'root' && !UUID_PATTERN.test(parentId)) {
    throw new HTTPException(400, { message: 'parentId must be a valid UUID or root' });
  }
  const searchPattern = `%${textQuery}%`;

  const parseDateFilter = (value: string | undefined, field: string): string | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HTTPException(400, { message: `${field} must be a valid date` });
    }
    return parsed.toISOString();
  };
  const normalizedCreatedAfter = parseDateFilter(createdAfter, 'createdAfter');
  const normalizedCreatedBefore = parseDateFilter(createdBefore, 'createdBefore');
  if (
    normalizedCreatedAfter &&
    normalizedCreatedBefore &&
    normalizedCreatedAfter > normalizedCreatedBefore
  ) {
    throw new HTTPException(400, { message: 'createdAfter must not be after createdBefore' });
  }

  const filters: SQL[] = [];

  if (normalizedCreatedAfter) {
    filters.push(sql`p.created_at >= ${normalizedCreatedAfter}`);
  }

  if (normalizedCreatedBefore) {
    filters.push(sql`p.created_at <= ${normalizedCreatedBefore}`);
  }

  if (parentId === 'root') {
    filters.push(sql`(
      p.parent_id is null
      or p.parent_id not in (select folder_id from get_enumerable_folder_ids(${user.id}))
    )`);
  } else if (parentId) {
    filters.push(sql`(
      p.parent_id = ${parentId}
      and ${parentId}::uuid in (select folder_id from get_enumerable_folder_ids(${user.id}))
    )`);
  }

  if (tagSlugs.length > 0) {
    filters.push(sql`p.id in (
      select c.source_id
      from connections c
      where c.connection_type = 'tag'
        and c.target_slug = any(${sql.param(tagSlugs)}::text[])
      group by c.source_id
      having count(distinct c.target_slug) = ${tagSlugs.length}
    )`);
  }

  const whereClause = filters.length > 0 ? sql`and ${sql.join(filters, sql` and `)}` : sql.empty();
  const textSearchClause = textQuery
    ? sql`and (p.title_search @@ plainto_tsquery('english', ${textQuery}) or p.title ilike ${searchPattern})`
    : sql.empty();

  const result = await query(
    sql`select p.id,
      p.title,
      p.icon,
      coalesce(breadcrumbs.breadcrumb, '{}'::text[]) as breadcrumb,
      ts_rank(p.title_search, plainto_tsquery('english', ${textQuery})) as rank
    from pages p
    left join lateral (
      with recursive visible_path as (
        select f.id, f.parent_id, f.name, 0 as depth
        from folders f
        where f.id = p.parent_id
          and f.is_deleted = false
          and f.id in (select folder_id from get_enumerable_folder_ids(${user.id}))

        union all

        select parent.id, parent.parent_id, parent.name, child.depth + 1
        from visible_path child
        join folders parent on parent.id = child.parent_id
        where parent.is_deleted = false
          and parent.id in (select folder_id from get_enumerable_folder_ids(${user.id}))
      )
      select array_agg(name order by depth desc) as breadcrumb
      from visible_path
    ) breadcrumbs on true
    where p.is_deleted = false
      and p.id in (select page_id from get_accessible_page_ids(${user.id}))
      ${textSearchClause}
      ${whereClause}
    order by rank desc nulls last
    limit 20`,
  );

  const results = (result.rows as SearchRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    icon: row.icon,
    breadcrumb: row.breadcrumb ?? [],
    path: [row.title],
  }));

  return c.json({ results });
});

export default searchRoute;
