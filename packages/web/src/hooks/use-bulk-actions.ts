import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { beginBulkRemoval } from '../utils/bulkRemovalState';
import { leaveEntity, useBulkLeaveEntities } from '../utils/entity-actions';
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

export interface BulkRemovalItem {
  id: string;
  type: 'page' | 'folder';
}

export interface BulkRemovalResult {
  removedItems: BulkRemovalItem[];
  failedItems: BulkRemovalItem[];
}

export class BulkRemovalError extends Error {
  readonly result: BulkRemovalResult;

  constructor(result: BulkRemovalResult) {
    super(`${result.removedItems.length} removed, ${result.failedItems.length} failed`);
    this.name = 'BulkRemovalError';
    this.result = result;
  }
}

type BulkRemovalOperation = BulkRemovalItem & { run: () => Promise<unknown> };

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
  ['shares'],
  ['pageCollaborators'],
  ['folderCollaborators'],
] as const;

async function removeEntities(input: BulkRemovalInput): Promise<BulkRemovalResult> {
  const operationGroups: BulkRemovalOperation[][] = [
    input.pageIdsToDelete.map((id) => ({ id, type: 'page', run: () => deletePage(id) })),
    input.folderIdsToDelete.map((id) => ({ id, type: 'folder', run: () => deleteFolder(id) })),
    input.pageIdsToLeave.map((id) => ({ id, type: 'page', run: () => leaveEntity('page', id) })),
    input.folderIdsToLeave.map((id) => ({
      id,
      type: 'folder',
      run: () => leaveEntity('folder', id),
    })),
  ];
  const result: BulkRemovalResult = { removedItems: [], failedItems: [] };

  // Preserve the existing per-entity-type request concurrency while delaying
  // all cache refreshes and user feedback until every group has settled.
  for (const operations of operationGroups) {
    const settled = await Promise.allSettled(operations.map((operation) => operation.run()));
    settled.forEach((operationResult, index) => {
      const operation = operations[index];
      if (!operation) throw new Error('Bulk removal result did not match its operation');
      const item = { id: operation.id, type: operation.type };
      if (operationResult.status === 'fulfilled') result.removedItems.push(item);
      else result.failedItems.push(item);
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
  return useMutation({
    mutationKey: BULK_REMOVAL_MUTATION_KEY,
    mutationFn: removeEntities,
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
        if (result) {
          const removedCount = result.removedItems.length;
          const suffix = removedCount === 1 ? 'item' : 'items';
          showSuccessToast(`Removed ${removedCount} ${suffix}`);
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
    onSuccess: () => {
      showSuccessToast('Pages moved to trash');
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
    onSuccess: () => {
      showSuccessToast('Folders moved to trash');
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
