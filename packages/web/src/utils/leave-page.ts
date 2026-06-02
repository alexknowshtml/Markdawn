/**
 * Client-side coordination for self-initiated leave operations.
 *
 * When a user leaves a shared page (via the "Delete" context menu on a non-owned page),
 * the mutation fires POST /leave which notifies the collab server via pg_notify.
 * The collab server then sends a revoke event over WebSocket, which MilkdownEditor
 * handles by showing a toast + navigating away.
 *
 * Without coordination, the user would see TWO toasts:
 *   1. "Removed from your view" from the collab revoke handler
 *   2. "Removed from your view" from the mutation onSuccess
 *
 * This module lets handleDeletePage signal that the leave was self-initiated,
 * so MilkdownEditor can skip its toast (the mutation handles feedback).
 *
 * For admin-initiated revokes (admin removes your access while you're on the page),
 * no flag is set, so MilkdownEditor shows its toast as before.
 */

const SELF_LEAVE_WINDOW_MS = 5_000;

let selfLeavePageId: string | null = null;
let selfLeaveTimestamp = 0;

/** Signal that a self-initiated leave is in progress for the given page. */
export function markSelfLeave(pageId: string): void {
  selfLeavePageId = pageId;
  selfLeaveTimestamp = Date.now();
}

/**
 * Check whether a revoke event was self-initiated.
 * Returns true once per self-leave (consumes the flag).
 * Returns false for admin-initiated revokes or stale flags.
 */
export function consumeSelfLeave(pageId: string): boolean {
  if (selfLeavePageId === pageId && Date.now() - selfLeaveTimestamp < SELF_LEAVE_WINDOW_MS) {
    selfLeavePageId = null;
    selfLeaveTimestamp = 0;
    return true;
  }
  return false;
}
