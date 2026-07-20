import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';

const DECIMAL_POSITION = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_POSITION_LENGTH = 128;

export const INVALID_POSITION_CODE = 'INVALID_POSITION';

type PositionedEntity = 'folders' | 'pages';

/**
 * Returns a database-normalized decimal position without routing PostgreSQL
 * numerics through JavaScript's lossy number representation.
 *
 * A user-supplied position can already occupy the full 128-character limit.
 * In that case no larger integer fits the constraint, so reuse the current
 * maximum. Equal positions are supported and are preferable to making future
 * creates fail until the sibling list is reordered.
 */
export async function getNextPosition(
  entity: PositionedEntity,
  parentId: string | null,
  ownerId: string,
  executor: QueryExecutor = db,
): Promise<string> {
  const scope = parentId
    ? sql`parent_id = ${parentId}`
    : sql`parent_id is null and created_by = ${ownerId}`;
  const result = await executeQuery<{ next_position: string }>(
    executor,
    sql`with current_position as (
       select max(position::numeric) as maximum
       from ${sql.identifier(entity)}
       where ${scope} and is_deleted = false
     ), candidate as (
       select maximum, coalesce(maximum, -1::numeric) + 1 as value
       from current_position
     )
     select case
       when char_length(value::text) <= ${MAX_POSITION_LENGTH} then value::text
       else maximum::text
     end as next_position
     from candidate`,
  );

  const nextPosition = result.rows[0]?.next_position;
  if (typeof nextPosition !== 'string' || nextPosition.length === 0) {
    throw new Error(`Failed to compute the next ${entity} position`);
  }
  return nextPosition;
}

export function normalizePosition(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;

  const normalized =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (
    normalized.length > 0 &&
    normalized.length <= MAX_POSITION_LENGTH &&
    DECIMAL_POSITION.test(normalized) &&
    Number.isFinite(Number(normalized))
  ) {
    return normalized;
  }

  throw new HTTPException(400, {
    message: 'Position must be a finite decimal number',
    cause: { code: INVALID_POSITION_CODE },
  });
}
