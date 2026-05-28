import type { Folder, FolderTreeNode } from '@markdawn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

async function fetchFolderTree(): Promise<FolderTreeNode[]> {
  const res = await fetch(`${API_BASE}/folders/tree`);
  if (!res.ok) {
    throw new Error('Failed to fetch folder tree');
  }
  return res.json();
}

async function createFolder(parentId?: string): Promise<Folder> {
  const res = await fetch(`${API_BASE}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name: 'New Folder' }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create folder' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function deleteFolder(folderId: string, force?: boolean): Promise<void> {
  const url = force
    ? `${API_BASE}/folders/${folderId}?force=true`
    : `${API_BASE}/folders/${folderId}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete folder' }));
    throw new Error(error.message);
  }
}

export type DeleteFolderResponse = {
  requiresForce?: boolean;
  childFolders?: number;
  childPages?: number;
  message?: string;
  deleted?: boolean;
};

async function updateFolder(
  folderId: string,
  updates: { name?: string; icon?: string | null; parentId?: string | null; position?: string },
): Promise<Folder> {
  const res = await fetch(`${API_BASE}/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update folder' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useFolderTree() {
  return useQuery({
    queryKey: ['folderTree'],
    queryFn: () => fetchFolderTree(),
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId }: { parentId?: string }) => createFolder(parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      showSuccessToast('Folder created');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, force }: { folderId: string; force?: boolean }) =>
      deleteFolder(folderId, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      showSuccessToast('Folder moved to trash');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useUpdateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      folderId,
      updates,
    }: {
      folderId: string;
      updates: { name?: string; icon?: string | null; parentId?: string | null; position?: string };
    }) => updateFolder(folderId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      showSuccessToast('Folder updated');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}
