import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

export interface RecentPage {
  id: string;
  title: string;
  icon: string | null;
  visitedAt: string;
}

async function fetchRecentPages(workspaceId: string): Promise<RecentPage[]> {
  const res = await fetch(`${API_BASE}/pages/recent?workspaceId=${workspaceId}&limit=5`);
  if (!res.ok) {
    throw new Error('Failed to fetch recent pages');
  }
  return res.json();
}

export function useRecentPages(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['recentPages', workspaceId],
    queryFn: () => fetchRecentPages(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 1000 * 60,
  });
}
