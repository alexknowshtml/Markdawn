import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Page, PageTreeNode } from '@markdawn/shared';
import { showSuccessToast, showErrorToast } from '../utils/toast';

const API_BASE = '/api';

async function fetchPageTree(workspaceId: string): Promise<PageTreeNode[]> {
  const res = await fetch(`${API_BASE}/pages/tree?workspaceId=${workspaceId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page tree');
  }
  return res.json();
}

async function createPage(workspaceId: string, parentId?: string, title?: string): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, parentId, title: title ?? 'Untitled' }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create page' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function updatePage(pageId: string, updates: Partial<Page>): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error('Failed to update page');
  }
  return res.json();
}

async function deletePage(pageId: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete page' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function fetchTrashPages(workspaceId: string): Promise<Page[]> {
  const res = await fetch(`${API_BASE}/pages/trash?workspaceId=${workspaceId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch trash pages');
  }
  return res.json();
}

async function restorePage(pageId: string): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/restore`, {
    method: 'PATCH',
  });
  if (!res.ok) {
    throw new Error('Failed to restore page');
  }
  return res.json();
}

async function permanentDeletePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/permanent`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to permanently delete page');
  }
}

async function movePage(pageId: string, parentId: string | null, position: string): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, position }),
  });
  if (!res.ok) {
    throw new Error('Failed to move page');
  }
  return res.json();
}

async function importMarkdown(workspaceId: string, file: File): Promise<Page> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/import/markdown?workspaceId=${workspaceId}`, {
    method: 'POST',
    body: formData },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to import markdown' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function usePageTree(workspaceId: string) {
  return useQuery({
    queryKey: ['pageTree', workspaceId],
    queryFn: () => fetchPageTree(workspaceId),
    enabled: !!workspaceId,
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, parentId, title }: { workspaceId: string; parentId?: string; title?: string }) =>
      createPage(workspaceId, parentId, title),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
      showSuccessToast('Page created');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, updates }: { pageId: string; updates: Partial<Page> }) =>
      updatePage(pageId, updates),
    onSuccess: (_, { pageId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail', pageId] });
      showSuccessToast('Page updated');
    },
    onError: () => {
      showErrorToast('Failed to update page');
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => deletePage(pageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      showSuccessToast('Moved to trash');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useTrashPages(workspaceId: string) {
  return useQuery({
    queryKey: ['trashPages', workspaceId],
    queryFn: () => fetchTrashPages(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => restorePage(pageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      showSuccessToast('Page restored');
    },
    onError: () => {
      showErrorToast('Failed to restore page');
    },
  });
}

export function usePermanentDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => permanentDeletePage(pageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      showSuccessToast('Page permanently deleted');
    },
    onError: () => {
      showErrorToast('Failed to permanently delete page');
    },
  });
}

export function useMovePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, parentId, position }: { pageId: string; parentId: string | null; position: string }) =>
      movePage(pageId, parentId, position),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      showSuccessToast('Page moved');
    },
    onError: () => {
      showErrorToast('Failed to move page');
    },
  });
}

export function useImportMarkdown() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, file }: { workspaceId: string; file: File }) =>
      importMarkdown(workspaceId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'content'] });
      showSuccessToast('Note imported');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function usePages(workspaceId: string) {
  const query = usePageTree(workspaceId);
  const pages = useMemo(() => {
    const result: Page[] = [];
    const walk = (nodes: PageTreeNode[] | undefined) => {
      if (!nodes) return;
      nodes.forEach((node) => {
        result.push(node);
        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      });
    };
    walk(query.data);
    return result;
  }, [query.data]);

  return {
    ...query,
    data: pages,
  };
}
