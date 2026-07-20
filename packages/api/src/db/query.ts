import type { SQL } from 'drizzle-orm';
import type { QueryResult, QueryResultRow } from 'pg';

import { db } from './connection';

export type QueryExecutor = {
  execute: (query: SQL) => Promise<QueryResult<QueryResultRow>>;
};

export async function query<T extends QueryResultRow = QueryResultRow>(
  statement: SQL,
): Promise<QueryResult<T>> {
  return executeQuery(db, statement);
}

export async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  executor: QueryExecutor,
  statement: SQL,
): Promise<QueryResult<T>> {
  try {
    const result = await executor.execute(statement);
    return result as QueryResult<T>;
  } catch (error) {
    if (error instanceof Error && 'cause' in error && error.cause instanceof Error) {
      throw error.cause;
    }
    throw error;
  }
}
