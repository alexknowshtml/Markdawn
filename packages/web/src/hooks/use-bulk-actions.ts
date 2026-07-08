import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBulkLeaveEntities } from '../utils/entity-actions';
import { showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

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

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ pageIds }: { pageIds: string[] }) => {
      await Promise.all(pageIds.map((id) => deletePage(id)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      showSuccessToast('Pages moved to trash');
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
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      showSuccessToast('Folders moved to trash');
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
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      showSuccessToast('Pages moved');
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
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      showSuccessToast('Folders moved');
    },
  });
}

export function useBulkLeavePages() {
  return useBulkLeaveEntities('page');
}

export function useBulkLeaveFolders() {
  return useBulkLeaveEntities('folder');
}
