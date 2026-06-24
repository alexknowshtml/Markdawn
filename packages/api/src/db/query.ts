import { type SQL, type SQLChunk, sql } from 'drizzle-orm';
import type { QueryResult, QueryResultRow } from 'pg';

import { db } from './connection';

const placeholderPattern = /\$(\d+)/g;

export type QueryExecutor = {
  execute: (query: SQL) => Promise<QueryResult<QueryResultRow>>;
};

export function bindSql(text: string, values: readonly unknown[] = []): SQL {
  if (values.length === 0) {
    return sql.raw(text);
  }

  const chunks: SQLChunk[] = [];
  let cursor = 0;

  for (const match of text.matchAll(placeholderPattern)) {
    const placeholderIndex = match.index;
    if (placeholderIndex === undefined) continue;

    const placeholder = match[0];
    const valueIndex = Number.parseInt(match[1] ?? '', 10) - 1;
    if (!Number.isInteger(valueIndex) || valueIndex < 0 || valueIndex >= values.length) {
      throw new Error(`Missing SQL parameter for ${placeholder}`);
    }

    if (placeholderIndex > cursor) {
      chunks.push(sql.raw(text.slice(cursor, placeholderIndex)));
    }
    chunks.push(sql.param(values[valueIndex]));
    cursor = placeholderIndex + placeholder.length;
  }

  if (cursor < text.length) {
    chunks.push(sql.raw(text.slice(cursor)));
  }

  return sql.join(chunks);
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> {
  return executeQuery(db, text, values);
}

export async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  executor: QueryExecutor,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> {
  try {
    const result = await executor.execute(bindSql(text, values ?? []));
    return result as QueryResult<T>;
  } catch (error) {
    if (error instanceof Error && 'cause' in error && error.cause instanceof Error) {
      throw error.cause;
    }
    throw error;
  }
}
