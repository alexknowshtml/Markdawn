import { useMutation, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

async function deletePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete page');
}

async function deleteFolder(folderId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${folderId}`, { method: 'DELETE' });
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
    mutationFn: async ({ pageIds, workspaceId }: { pageIds: string[]; workspaceId: string }) => {
      await Promise.all(pageIds.map((id) => deletePage(id)));
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['trashPages', workspaceId] });
      showSuccessToast('Pages moved to trash');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useBulkDeleteFolders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderIds,
      workspaceId,
    }: { folderIds: string[]; workspaceId: string }) => {
      await Promise.all(folderIds.map((id) => deleteFolder(id)));
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['folderTree', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Folders moved to trash');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useBulkMovePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      pageIds,
      parentId,
      workspaceId,
    }: { pageIds: string[]; parentId: string | null; workspaceId: string }) => {
      await Promise.all(pageIds.map((id) => movePage(id, parentId)));
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Pages moved');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useBulkMoveFolders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderIds,
      parentId,
      workspaceId,
    }: { folderIds: string[]; parentId: string | null; workspaceId: string }) => {
      await Promise.all(folderIds.map((id) => moveFolder(id, parentId)));
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['folderTree', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Folders moved');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}
