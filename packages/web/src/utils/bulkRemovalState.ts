let activeBulkRemovals = 0;

export function beginBulkRemoval(): () => void {
  activeBulkRemovals += 1;
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    activeBulkRemovals = Math.max(0, activeBulkRemovals - 1);
  };
}

export function isBulkRemovalInProgress(): boolean {
  return activeBulkRemovals > 0;
}
