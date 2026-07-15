import { describe, expect, it, vi } from 'vitest';
import { createCoalescingTaskQueue } from './coalescingTaskQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('createCoalescingTaskQueue', () => {
  it('keeps only the latest pending task for a key', async () => {
    const firstTask = deferred();
    const handled: string[] = [];
    const queue = createCoalescingTaskQueue<{ key: string; value: string }>({
      maxPending: 4,
      getKey: (task) => task.key,
      handle: async (task) => {
        handled.push(task.value);
        if (task.value === 'first') await firstTask.promise;
      },
      handleOverflow: vi.fn(),
      onError: vi.fn(),
    });

    queue.enqueue({ key: 'first', value: 'first' });
    queue.enqueue({ key: 'same', value: 'stale' });
    queue.enqueue({ key: 'same', value: 'latest' });
    queue.enqueue({ key: 'other', value: 'other' });
    firstTask.resolve();
    await queue.waitForIdle();

    expect(handled).toEqual(['first', 'latest', 'other']);
  });

  it('replaces an oversized backlog with a canonical refresh', async () => {
    const firstTask = deferred();
    const overflowTask = deferred();
    const handled: string[] = [];
    const handleOverflow = vi.fn(async () => overflowTask.promise);
    const queue = createCoalescingTaskQueue<{ key: string }>({
      maxPending: 2,
      getKey: (task) => task.key,
      handle: async (task) => {
        handled.push(task.key);
        if (task.key === 'first') await firstTask.promise;
      },
      handleOverflow,
      onError: vi.fn(),
    });

    queue.enqueue({ key: 'first' });
    queue.enqueue({ key: 'one' });
    queue.enqueue({ key: 'two' });
    queue.enqueue({ key: 'overflow' });
    queue.enqueue({ key: 'covered-by-overflow' });
    firstTask.resolve();

    await vi.waitFor(() => expect(handleOverflow).toHaveBeenCalledTimes(1));
    queue.enqueue({ key: 'after-overflow-started' });
    overflowTask.resolve();
    await queue.waitForIdle();

    expect(handled).toEqual(['first', 'after-overflow-started']);
  });
});
