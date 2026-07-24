import type { ShareEntityType } from './page.js';

export type BulkRemovalAction = 'trash' | 'remove-from-view';

export interface BulkRemovalOperation {
  entityType: ShareEntityType;
  entityId: string;
  action: BulkRemovalAction;
}

export interface BulkRemovalRequest {
  operations: BulkRemovalOperation[];
}

export interface BulkRemovalItem extends BulkRemovalOperation {}

export interface BulkRemovalFailure extends BulkRemovalOperation {
  code: 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR' | 'NOT_FOUND';
  message: string;
}

export interface BulkRemovalResult {
  removedItems: BulkRemovalItem[];
  failedItems: BulkRemovalFailure[];
  trashedCount: number;
  removedFromViewCount: number;
}
