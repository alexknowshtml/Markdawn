import { describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '../db/query';
import { recordPublicVisitAndNotify } from './publicAccess';

describe('recordPublicVisitAndNotify', () => {
  it('publishes a targeted metadata refresh only for a first public visit', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ inserted: true }] })
      .mockResolvedValue({
        rows: [],
      });
    const executor = { execute } as unknown as QueryExecutor;

    await expect(recordPublicVisitAndNotify(executor, 'page', 'page-1', 'user-1')).resolves.toBe(
      true,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not publish a redundant refresh for an existing public visit', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ inserted: false }] });
    const executor = { execute } as unknown as QueryExecutor;

    await expect(
      recordPublicVisitAndNotify(executor, 'folder', 'folder-1', 'user-1'),
    ).resolves.toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
});
