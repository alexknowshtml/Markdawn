import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

export interface Tag {
  id: string;
  name: string;
  page_count: number;
}

async function fetchTags(workspaceId: string): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/tags?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch tags');
  }
  return res.json();
}

async function fetchPagesByTag(
  workspaceId: string,
  tagId: string,
): Promise<{ id: string; title: string; icon: string | null; parentId: string | null }[]> {
  const res = await fetch(
    `${API_BASE}/tags/pages?workspaceId=${encodeURIComponent(workspaceId)}&tagId=${encodeURIComponent(tagId)}`,
  );
  if (!res.ok) {
    throw new Error('Failed to fetch pages by tag');
  }
  return res.json();
}

export function useTags(workspaceId?: string) {
  return useQuery({
    queryKey: ['tags', workspaceId],
    queryFn: () => {
      if (!workspaceId) throw new Error('workspaceId is required');
      return fetchTags(workspaceId);
    },
    enabled: !!workspaceId,
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });
}

export function usePagesByTag(workspaceId?: string, tagId?: string) {
  return useQuery({
    queryKey: ['tags', 'pages', workspaceId, tagId],
    queryFn: () => {
      if (!workspaceId || !tagId) throw new Error('workspaceId and tagId are required');
      return fetchPagesByTag(workspaceId, tagId);
    },
    enabled: !!workspaceId && !!tagId,
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });
}
