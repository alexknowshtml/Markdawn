import type { QueryResult, QueryResultRow } from 'pg';
import { db } from './connection';

/** Direct node-postgres access for integration fixtures only. */
export async function testQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> {
  return db.$client.query<T>(text, values ? [...values] : undefined);
}
