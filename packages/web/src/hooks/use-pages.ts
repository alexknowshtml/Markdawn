import type { Page, PageTreeNode } from '@markdawn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useLeaveEntity } from '../utils/entity-actions';
import { showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

async function fetchPageTree(): Promise<PageTreeNode[]> {
  const res = await fetch(`${API_BASE}/pages/tree`);
  if (!res.ok) {
    throw new Error('Failed to fetch page tree');
  }
  return res.json();
}

async function createPage(parentId?: string, title?: string): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, title: title ?? 'Untitled' }),
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

async function fetchTrashPages(): Promise<Page[]> {
  const res = await fetch(`${API_BASE}/pages/trash`);
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

async function emptyTrash(): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/trash/empty-all`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to empty trash');
  }
}

export function useLeavePage() {
  return useLeaveEntity('page');
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

async function importMarkdown(file: File): Promise<Page> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/import/markdown`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to import markdown' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function usePageTree() {
  return useQuery({
    queryKey: ['pageTree'],
    queryFn: () => fetchPageTree(),
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, title }: { parentId?: string; title?: string; silent?: boolean }) =>
      createPage(parentId, title),
    onSuccess: (_newPage, { silent }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      if (!silent) {
        showSuccessToast('Page created');
      }
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      pageId,
      updates,
    }: {
      pageId: string;
      updates: Partial<Page>;
      silent?: boolean;
    }) => updatePage(pageId, updates),
    onSuccess: (_, { pageId, silent }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail', pageId] });
      if (!silent) {
        showSuccessToast('Page updated');
      }
    },
    meta: { errorMessage: 'Failed to update page' },
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
  });
}

export function useTrashPages() {
  return useQuery({
    queryKey: ['trashPages'],
    queryFn: () => fetchTrashPages(),
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
    meta: { errorMessage: 'Failed to restore page' },
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
    meta: { errorMessage: 'Failed to permanently delete page' },
  });
}

export function useEmptyTrash() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => emptyTrash(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      showSuccessToast('Trash emptied');
    },
    meta: { errorMessage: 'Failed to empty trash' },
  });
}

export function useMovePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      pageId,
      parentId,
      position,
    }: {
      pageId: string;
      parentId: string | null;
      position: string;
    }) => movePage(pageId, parentId, position),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      showSuccessToast('Page moved');
    },
    meta: { errorMessage: 'Failed to move page' },
  });
}

export function useImportMarkdown() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file }: { file: File }) => importMarkdown(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'content'] });
      showSuccessToast('Note imported');
    },
  });
}

export function usePages() {
  const query = usePageTree();
  const pages = useMemo(() => {
    const result: Page[] = [];
    const walk = (nodes: PageTreeNode[] | undefined) => {
      if (!nodes) return;
      for (const node of nodes) {
        result.push(node);
        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    walk(query.data);
    return result;
  }, [query.data]);

  return {
    ...query,
    data: pages,
  };
}
