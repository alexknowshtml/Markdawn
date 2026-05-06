import type { Folder, Page } from '@markdawn/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

async function copyPage(pageId: string, parentId?: string | null): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to copy page' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function copyFolder(folderId: string, parentId?: string | null): Promise<Folder> {
  const res = await fetch(`${API_BASE}/folders/${folderId}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to copy folder' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useCopyPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      pageId,
      parentId,
      workspaceId,
    }: { pageId: string; parentId?: string | null; workspaceId: string }) =>
      copyPage(pageId, parentId),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Page copied');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useCopyFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      folderId,
      parentId,
      workspaceId,
    }: { folderId: string; parentId?: string | null; workspaceId: string }) =>
      copyFolder(folderId, parentId),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['folderTree', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Folder copied');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}
