import type { CollaboratorDisplay } from '@markdawn/shared';
import { useQuery } from '@tanstack/react-query';
import { isBulkRemovalInProgress } from '../utils/bulkRemovalState';

const API_BASE = '/api';

type CollaboratorsResponse = Record<string, CollaboratorDisplay[]>;

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
    refetchOnWindowFocus: () => !isBulkRemovalInProgress(),
    refetchOnReconnect: () => !isBulkRemovalInProgress(),
  });
}

async function fetchFolderCollaborators(folderIds: string[]): Promise<CollaboratorsResponse> {
  if (folderIds.length === 0) return {};
  const res = await fetch(
    `${API_BASE}/shares/folders/collaborators?folderIds=${folderIds.join(',')}`,
  );
  if (!res.ok) {
    throw new Error('Failed to fetch folder collaborators');
  }
  return res.json();
}

export function useFolderCollaborators(folderIds: string[]) {
  const sortedIds = [...new Set(folderIds)].sort();
  return useQuery({
    queryKey: ['folderCollaborators', sortedIds],
    queryFn: () => fetchFolderCollaborators(sortedIds),
    staleTime: 1000 * 60,
    enabled: sortedIds.length > 0,
    refetchOnWindowFocus: () => !isBulkRemovalInProgress(),
    refetchOnReconnect: () => !isBulkRemovalInProgress(),
  });
}
