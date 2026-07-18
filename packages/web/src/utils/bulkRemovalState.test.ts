import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginBulkRemoval,
  isBulkRemovalInProgress,
  resetBulkRemovalState,
} from './bulkRemovalState';

describe('bulkRemovalState', () => {
  beforeEach(() => resetBulkRemovalState());

  it('does not let a retired identity release the active identity counter', () => {
    const endUserARemoval = beginBulkRemoval();
    expect(isBulkRemovalInProgress()).toBe(true);

    resetBulkRemovalState();
    const endUserBRemoval = beginBulkRemoval();
    expect(isBulkRemovalInProgress()).toBe(true);

    endUserARemoval();
    expect(isBulkRemovalInProgress()).toBe(true);

    endUserBRemoval();
    expect(isBulkRemovalInProgress()).toBe(false);
  });
});
