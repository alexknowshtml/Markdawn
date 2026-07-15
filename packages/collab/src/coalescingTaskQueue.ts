export type CoalescingTaskQueueOptions<T> = {
  maxPending: number;
  getKey: (task: T) => string;
  handle: (task: T) => Promise<void>;
  handleOverflow: () => Promise<void>;
  onError: (error: unknown) => void;
};

export type CoalescingTaskQueue<T> = {
  enqueue: (task: T) => void;
  stop: () => void;
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
  const idleResolvers = new Set<() => void>();
  let overflowPending = false;
  let overflowRunning = false;
  let processing = false;
  let stopped = false;

  const hasWork = () => overflowPending || pending.size > 0;

  const resolveIdle = () => {
    if (processing || hasWork()) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };

  const process = async () => {
    if (processing || stopped) return;
    processing = true;

    try {
      while (!stopped && hasWork()) {
        if (overflowPending) {
          overflowPending = false;
          overflowRunning = true;
          try {
            await options.handleOverflow();
          } catch (error) {
            options.onError(error);
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
        }
      }
    } finally {
      processing = false;
      if (!stopped && hasWork()) {
        void process();
      } else {
        resolveIdle();
      }
    }
  };

  return {
    enqueue(task) {
      if (stopped) return;

      const key = options.getKey(task);
      if (pending.has(key)) {
        pending.set(key, task);
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
      stopped = true;
      pending.clear();
      overflowPending = false;
      resolveIdle();
    },
    waitForIdle() {
      if (!processing && !hasWork()) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.add(resolve));
    },
  };
}
