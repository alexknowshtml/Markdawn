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
    mutationFn: ({ pageId, parentId }: { pageId: string; parentId?: string | null }) =>
      copyPage(pageId, parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
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
    mutationFn: ({ folderId, parentId }: { folderId: string; parentId?: string | null }) =>
      copyFolder(folderId, parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      showSuccessToast('Folder copied');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}
