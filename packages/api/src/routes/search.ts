import { Hono } from 'hono';
import { query } from '../db/query';
import { requireAuth } from '../middleware/auth';

type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  breadcrumb: string[] | null;
};

const searchRoute = new Hono();

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
  const searchPattern = `%${textQuery}%`;

  const filters: string[] = [];
  const params: unknown[] = [user.id, textQuery, searchPattern];
  let paramIndex = 4;

  if (createdAfter) {
    filters.push(`p.created_at >= $${paramIndex}`);
    params.push(createdAfter);
    paramIndex += 1;
  }

  if (createdBefore) {
    filters.push(`p.created_at <= $${paramIndex}`);
    params.push(createdBefore);
    paramIndex += 1;
  }

  if (parentId === 'root') {
    filters.push('p.parent_id is null');
  } else if (parentId) {
    filters.push(`p.parent_id = $${paramIndex}`);
    params.push(parentId);
    paramIndex += 1;
  }

  if (tagSlugs.length > 0) {
    filters.push(`p.id in (
      select c.source_id
      from connections c
      where c.connection_type = 'tag'
        and c.target_slug = any($${paramIndex}::text[])
      group by c.source_id
      having count(distinct c.target_slug) = $${paramIndex + 1}
    )`);
    params.push(tagSlugs, tagSlugs.length);
    paramIndex += 2;
  }

  const whereClause = filters.length > 0 ? ` and ${filters.join(' and ')}` : '';
  const textSearchClause = textQuery
    ? `and (p.title_search @@ plainto_tsquery('english', $2) or p.title ilike $3)`
    : '';

  const result = await query(
    `select p.id,
      p.title,
      p.icon,
      coalesce(breadcrumbs.breadcrumb, '{}'::text[]) as breadcrumb,
      ts_rank(p.title_search, plainto_tsquery('english', $2)) as rank
    from pages p
    left join lateral (
      select array_agg(f.name order by fc.depth desc) as breadcrumb
      from folder_closure fc
      join folders f on f.id = fc.ancestor_id
      where fc.descendant_id = p.parent_id
        and fc.depth > 0
    ) breadcrumbs on true
    where p.is_deleted = false
      and p.id in (select page_id from get_accessible_page_ids($1))
      ${textSearchClause}
      ${whereClause}
    order by rank desc nulls last
    limit 20`,
    params,
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
