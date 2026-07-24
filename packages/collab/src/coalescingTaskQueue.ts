export type CoalescingTaskQueueOptions<T> = {
  maxPending: number;
  getKey: (task: T) => string;
  mergePending?: (existing: T, incoming: T) => T;
  handle: (task: T) => Promise<void>;
  handleOverflow: () => Promise<void>;
  onError: (error: unknown) => void;
  overflowRetryDelayMs?: number;
};

export type CoalescingTaskQueue<T> = {
  enqueue: (task: T) => void;
  stop: () => void;
  drainAndStop: () => void;
  waitForIdle: () => Promise<void>;
};

/**
 * Runs one task at a time, retains only the latest pending task for each key,
 * and replaces an oversized backlog with one canonical full-state refresh.
 */
export function createCoalescingTaskQueue<T>(
  options: CoalescingTaskQueueOptions<T>,
): CoalescingTaskQueue<T> {
  if (!Number.isInteger(options.maxPending) || options.maxPending < 1) {
    throw new Error('maxPending must be a positive integer');
  }

  const pending = new Map<string, T>();
  const overflowRetryDelayMs = options.overflowRetryDelayMs ?? 1000;
  const idleResolvers = new Set<() => void>();
  let overflowPending = false;
  let overflowRunning = false;
  let processing = false;
  let accepting = true;
  let discardPending = false;

  const hasWork = () => overflowPending || pending.size > 0;

  const resolveIdle = () => {
    if (processing || hasWork()) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };

  const process = async () => {
    if (processing || discardPending) return;
    processing = true;

    try {
      while (!discardPending && hasWork()) {
        if (overflowPending) {
          overflowPending = false;
          overflowRunning = true;
          try {
            await options.handleOverflow();
          } catch (error) {
            options.onError(error);
            if (accepting) {
              overflowPending = true;
              await new Promise<void>((resolve) => setTimeout(resolve, overflowRetryDelayMs));
            }
          } finally {
            overflowRunning = false;
          }
          continue;
        }

        const first = pending.entries().next().value as [string, T] | undefined;
        if (!first) continue;
        const [key, task] = first;
        pending.delete(key);
        try {
          await options.handle(task);
        } catch (error) {
          options.onError(error);
          if (accepting) {
            // The canonical refresh reflects all committed state, including
            // this failed task and every task that was pending behind it.
            pending.clear();
            overflowPending = true;
          }
        }
      }
    } finally {
      processing = false;
      if (!discardPending && hasWork()) {
        void process();
      } else {
        resolveIdle();
      }
    }
  };

  return {
    enqueue(task) {
      if (!accepting) return;

      const key = options.getKey(task);
      if (pending.has(key)) {
        const existing = pending.get(key) as T;
        pending.set(key, options.mergePending?.(existing, task) ?? task);
      } else if (overflowPending && !overflowRunning) {
        // The canonical refresh has not started, so it will include this task's
        // already-committed database state.
      } else if (pending.size >= options.maxPending) {
        pending.clear();
        overflowPending = true;
      } else {
        pending.set(key, task);
      }
      void process();
    },
    stop() {
      accepting = false;
      discardPending = true;
      pending.clear();
      overflowPending = false;
      resolveIdle();
    },
    drainAndStop() {
      accepting = false;
      void process();
      resolveIdle();
    },
    waitForIdle() {
      if (!processing && !hasWork()) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.add(resolve));
    },
  };
}
