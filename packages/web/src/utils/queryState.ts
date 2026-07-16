interface QueryState {
  data: unknown;
  error: unknown;
}

export function hasInitialQueryError(queries: QueryState[]): boolean {
  return queries.some(
    ({ data, error }) => data === undefined && error !== null && error !== undefined,
  );
}
