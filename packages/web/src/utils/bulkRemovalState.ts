let activeBulkRemovals = 0;
let bulkRemovalGeneration = 0;

export function beginBulkRemoval(): () => void {
  const generation = bulkRemovalGeneration;
  activeBulkRemovals += 1;
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    if (generation !== bulkRemovalGeneration) return;
    activeBulkRemovals = Math.max(0, activeBulkRemovals - 1);
  };
}

export function isBulkRemovalInProgress(): boolean {
  return activeBulkRemovals > 0;
}

/** Reset process-local coordination before a different identity mounts. */
export function resetBulkRemovalState(): void {
  bulkRemovalGeneration += 1;
  activeBulkRemovals = 0;
}
