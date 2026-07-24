export type DocumentContentLock = {
  run<T>(documentName: string, task: () => Promise<T>): Promise<T>;
};

/**
 * Serializes database content checks and writes for each loaded document.
 *
 * A reconnect reconciliation must not observe a committed write before the
 * in-memory hash that represents it has been updated.
 */
export function createDocumentContentLock(): DocumentContentLock {
  const tails = new Map<string, Promise<void>>();

  const run = async <T>(documentName: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(documentName) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(documentName, tail);

    await previous;
    try {
      return await task();
    } finally {
      release?.();
      if (tails.get(documentName) === tail) tails.delete(documentName);
    }
  };

  return { run };
}
