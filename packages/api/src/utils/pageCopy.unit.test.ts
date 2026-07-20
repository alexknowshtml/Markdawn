import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '../db/query';
import { type PageCopySource, persistPageCopies } from './pageCopy';

const source = (index: number): PageCopySource => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  title: `Page ${index}`,
  icon: null,
  coverType: null,
  coverValue: null,
  ydoc: null,
  properties: null,
});

const requests = Array.from({ length: 251 }, (_, index) => ({
  source: source(index),
  options: { parentId: null, position: String(index), connectionPolicy: 'all' as const },
}));

describe('persistPageCopies', () => {
  it('writes large copies in bounded batches', async () => {
    const execute = vi.fn(async () => ({ rows: [], rowCount: 0 }) as unknown as QueryResult);
    await persistPageCopies({ execute } as QueryExecutor, requests, {
      kind: 'user',
      id: source(999).id,
    });
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it('stops immediately when a later batch fails so the caller transaction can roll back', async () => {
    const failure = new Error('later batch failed');
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 5) throw failure;
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    });
    await expect(
      persistPageCopies({ execute } as QueryExecutor, requests, {
        kind: 'user',
        id: source(999).id,
      }),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(5);
  });
});
