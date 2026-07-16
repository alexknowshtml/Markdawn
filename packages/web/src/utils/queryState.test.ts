import { describe, expect, it } from 'vitest';
import { hasInitialQueryError } from './queryState';

describe('hasInitialQueryError', () => {
  it('reports an initial load failure when no cached data exists', () => {
    expect(hasInitialQueryError([{ data: undefined, error: new Error('offline') }])).toBe(true);
  });

  it('keeps cached data visible after a background refresh failure', () => {
    expect(hasInitialQueryError([{ data: ['cached'], error: new Error('offline') }])).toBe(false);
  });
});
