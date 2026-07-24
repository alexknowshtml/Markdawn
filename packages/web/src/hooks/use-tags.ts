import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

export interface Tag {
  id: string;
  name: string;
  page_count: number;
}

async function fetchTags(): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/tags`);
  if (!res.ok) {
    throw new Error('Failed to fetch tags');
  }
  return res.json();
}

async function fetchPagesByTag(
  tagId: string,
): Promise<{ id: string; title: string; icon: string | null; parentId: string | null }[]> {
  const res = await fetch(`${API_BASE}/tags/pages?tagId=${encodeURIComponent(tagId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch pages by tag');
  }
  return res.json();
}

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => fetchTags(),
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });
}

export function usePagesByTag(tagId?: string) {
  return useQuery({
    queryKey: ['tags', 'pages', tagId],
    queryFn: () => {
      if (!tagId) throw new Error('tagId is required');
      return fetchPagesByTag(tagId);
    },
    enabled: !!tagId,
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });
}
