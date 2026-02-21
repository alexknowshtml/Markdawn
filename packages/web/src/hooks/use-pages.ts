import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Page, PageTreeNode } from '@markdawn/shared';

const API_BASE = '/api';

async function fetchPageTree(workspaceId: string): Promise<PageTreeNode[]> {
  const res = await fetch(`${API_BASE}/pages/tree?workspaceId=${workspaceId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page tree');
  }
  return res.json();
}

async function createPage(workspaceId: string, parentId?: string): Promise<Page> {
  const res = await fetch(`${API_BASE}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, parentId, title: 'Untitled' }),
  });
  if (!res.ok) {
    throw new Error('Failed to create page');
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

async function deletePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to delete page');
  }
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
    mutationFn: ({ workspaceId, parentId }: { workspaceId: string; parentId?: string }) =>
      createPage(workspaceId, parentId),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['pageTree', workspaceId] });
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
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => deletePage(pageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
    },
  });
}
