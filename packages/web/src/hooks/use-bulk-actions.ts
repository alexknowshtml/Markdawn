import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIdentityLifecycle } from '../contexts/IdentityLifecycleContext';
import { beginBulkRemoval } from '../utils/bulkRemovalState';
import { isOwnedByUser, leaveEntity, useBulkLeaveEntities } from '../utils/entity-actions';
import { showSuccessToast } from '../utils/toast';

const API_BASE = '/api';
const BULK_REMOVAL_MUTATION_KEY = ['bulk-removal'] as const;

async function deletePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete page');
}

async function deleteFolder(folderId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${folderId}?force=true`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete folder');
}

async function movePage(pageId: string, parentId: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) throw new Error('Failed to move page');
}

async function moveFolder(folderId: string, parentId: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) throw new Error('Failed to move folder');
}

export interface BulkRemovalInput {
  pageIdsToDelete: string[];
  folderIdsToDelete: string[];
  pageIdsToLeave: string[];
  folderIdsToLeave: string[];
}

export interface BulkRemovalCandidate {
  id: string;
  type: 'page' | 'folder';
  ownerId?: string | null | undefined;
  createdBy?: string | null | undefined;
  userPermission?: 'view' | 'edit' | 'admin' | null | undefined;
  shareSource?: 'direct' | 'public' | 'workspace' | undefined;
}

export function buildBulkRemovalInput(
  items: BulkRemovalCandidate[],
  currentUserId?: string,
): BulkRemovalInput {
  const input: BulkRemovalInput = {
    pageIdsToDelete: [],
    folderIdsToDelete: [],
    pageIdsToLeave: [],
    folderIdsToLeave: [],
  };
  for (const item of items) {
    const isOwned = !!currentUserId && isOwnedByUser(item, currentUserId);
    const canRemoveFromView =
      !isOwned && (item.shareSource === 'direct' || item.shareSource === 'public');
    if (!isOwned && !canRemoveFromView) continue;
    if (item.type === 'page') {
      (isOwned ? input.pageIdsToDelete : input.pageIdsToLeave).push(item.id);
    } else {
      (isOwned ? input.folderIdsToDelete : input.folderIdsToLeave).push(item.id);
    }
  }
  return input;
}

export function getBulkRemovalCounts(input: BulkRemovalInput): {
  trashCount: number;
  removeFromViewCount: number;
} {
  return {
    trashCount: input.pageIdsToDelete.length + input.folderIdsToDelete.length,
    removeFromViewCount: input.pageIdsToLeave.length + input.folderIdsToLeave.length,
  };
}

export interface BulkRemovalItem {
  id: string;
  type: 'page' | 'folder';
}

export interface BulkRemovalResult {
  removedItems: BulkRemovalItem[];
  failedItems: BulkRemovalItem[];
  trashedCount: number;
  removedFromViewCount: number;
}

export class BulkRemovalError extends Error {
  readonly result: BulkRemovalResult;

  constructor(result: BulkRemovalResult) {
    super(`${result.removedItems.length} removed, ${result.failedItems.length} failed`);
    this.name = 'BulkRemovalError';
    this.result = result;
  }
}

type BulkRemovalOperation = BulkRemovalItem & {
  outcome: 'trash' | 'remove-from-view';
  run: () => Promise<unknown>;
};

const formatBulkRemovalSuccess = ({
  trashedCount,
  removedFromViewCount,
}: Pick<BulkRemovalResult, 'trashedCount' | 'removedFromViewCount'>): string => {
  const outcomes: string[] = [];
  if (trashedCount > 0) {
    outcomes.push(`Moved ${trashedCount} item${trashedCount === 1 ? '' : 's'} to Trash`);
  }
  if (removedFromViewCount > 0) {
    outcomes.push(
      `removed ${removedFromViewCount} item${removedFromViewCount === 1 ? '' : 's'} from your view`,
    );
  }
  return outcomes.join('; ');
};

const BULK_REMOVAL_QUERY_KEYS = [
  ['folderTree'],
  ['pageTree'],
  ['trashPages'],
  ['shared-with-me'],
  ['workspace-memberships'],
  ['workspace-members'],
  ['pages', 'recent'],
  ['pages', 'detail'],
  ['folders', 'detail'],
  ['favorites'],
  ['tags'],
  ['shares'],
  ['pageCollaborators'],
  ['folderCollaborators'],
] as const;

async function removeEntities(
  input: BulkRemovalInput,
  isIdentityActive: () => boolean,
): Promise<BulkRemovalResult> {
  const operationGroups: BulkRemovalOperation[][] = [
    input.pageIdsToDelete.map((id) => ({
      id,
      type: 'page',
      outcome: 'trash',
      run: () => deletePage(id),
    })),
    input.folderIdsToDelete.map((id) => ({
      id,
      type: 'folder',
      outcome: 'trash',
      run: () => deleteFolder(id),
    })),
    input.pageIdsToLeave.map((id) => ({
      id,
      type: 'page',
      outcome: 'remove-from-view',
      run: () => leaveEntity('page', id),
    })),
    input.folderIdsToLeave.map((id) => ({
      id,
      type: 'folder',
      outcome: 'remove-from-view',
      run: () => leaveEntity('folder', id),
    })),
  ];
  const result: BulkRemovalResult = {
    removedItems: [],
    failedItems: [],
    trashedCount: 0,
    removedFromViewCount: 0,
  };

  // Preserve the existing per-entity-type request concurrency while delaying
  // all cache refreshes and user feedback until every group has settled.
  for (const operations of operationGroups) {
    // Each fetch captures the browser's cookie when it starts. Do not let a
    // mixed bulk operation begin a later request group after another identity
    // has taken over the tab.
    if (!isIdentityActive()) throw new Error('Identity retired during bulk removal');
    const settled = await Promise.allSettled(operations.map((operation) => operation.run()));
    settled.forEach((operationResult, index) => {
      const operation = operations[index];
      if (!operation) throw new Error('Bulk removal result did not match its operation');
      const item = { id: operation.id, type: operation.type };
      if (operationResult.status === 'fulfilled') {
        result.removedItems.push(item);
        if (operation.outcome === 'trash') result.trashedCount += 1;
        else result.removedFromViewCount += 1;
      } else result.failedItems.push(item);
    });
  }

  if (result.failedItems.length > 0) throw new BulkRemovalError(result);
  return result;
}

export function useIsBulkRemovalPending(): boolean {
  return useIsMutating({ mutationKey: BULK_REMOVAL_MUTATION_KEY }) > 0;
}

export function useBulkRemoveEntities() {
  const queryClient = useQueryClient();
  const identityLifecycle = useIdentityLifecycle();
  return useMutation({
    mutationKey: BULK_REMOVAL_MUTATION_KEY,
    mutationFn: (input: BulkRemovalInput) => removeEntities(input, identityLifecycle.isActive),
    onMutate: async () => {
      const endBulkRemoval = beginBulkRemoval();
      try {
        await Promise.all(
          BULK_REMOVAL_QUERY_KEYS.map((queryKey) => queryClient.cancelQueries({ queryKey })),
        );
        return endBulkRemoval;
      } catch (error) {
        endBulkRemoval();
        throw error;
      }
    },
    onSettled: async (result, _error, _input, endBulkRemoval) => {
      try {
        await Promise.all(
          BULK_REMOVAL_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
        if (!identityLifecycle.isActive()) return;
        if (result) {
          showSuccessToast(formatBulkRemovalSuccess(result));
        }
      } finally {
        endBulkRemoval?.();
      }
    },
  });
}

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ pageIds }: { pageIds: string[] }) => {
      await Promise.all(pageIds.map((id) => deletePage(id)));
    },
    onSuccess: (_result, { pageIds }) => {
      showSuccessToast(`Moved ${pageIds.length} page${pageIds.length === 1 ? '' : 's'} to Trash`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

export function useBulkDeleteFolders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ folderIds }: { folderIds: string[] }) => {
      await Promise.all(folderIds.map((id) => deleteFolder(id)));
    },
    onSuccess: (_result, { folderIds }) => {
      showSuccessToast(
        `Moved ${folderIds.length} folder${folderIds.length === 1 ? '' : 's'} to Trash`,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

export function useBulkMovePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ pageIds, parentId }: { pageIds: string[]; parentId: string | null }) => {
      await Promise.all(pageIds.map((id) => movePage(id, parentId)));
    },
    onSuccess: () => {
      showSuccessToast('Pages moved');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
    },
  });
}

export function useBulkMoveFolders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderIds,
      parentId,
    }: {
      folderIds: string[];
      parentId: string | null;
    }) => {
      await Promise.all(folderIds.map((id) => moveFolder(id, parentId)));
    },
    onSuccess: () => {
      showSuccessToast('Folders moved');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
    },
  });
}

export function useBulkLeavePages() {
  return useBulkLeaveEntities('page');
}

export function useBulkLeaveFolders() {
  return useBulkLeaveEntities('folder');
}
