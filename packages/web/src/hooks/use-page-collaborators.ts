import type { EntityAccessor } from '@markdawn/shared';
import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

type CollaboratorsResponse = Record<string, EntityAccessor[]>;

async function fetchPageCollaborators(pageIds: string[]): Promise<CollaboratorsResponse> {
  if (pageIds.length === 0) return {};
  const res = await fetch(`${API_BASE}/shares/pages/collaborators?pageIds=${pageIds.join(',')}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page collaborators');
  }
  return res.json();
}

export function usePageCollaborators(pageIds: string[]) {
  const sortedIds = [...new Set(pageIds)].sort();
  return useQuery({
    queryKey: ['pageCollaborators', sortedIds],
    queryFn: () => fetchPageCollaborators(sortedIds),
    staleTime: 1000 * 60,
    enabled: sortedIds.length > 0,
  });
}
