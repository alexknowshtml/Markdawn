import type { Workspace } from '@markdawn/shared';
import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await fetch(`${API_BASE}/workspaces`);
  if (!res.ok) {
    throw new Error('Failed to fetch workspaces');
  }
  return res.json();
}

async function fetchWorkspaceBySlug(slug: string): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/workspaces/${slug}`);
  if (!res.ok) {
    throw new Error('Failed to fetch workspace');
  }
  const data = await res.json();
  if (data?.workspace) {
    return data.workspace as Workspace;
  }
  return data as Workspace;
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
  });
}

export function useWorkspace(slug?: string) {
  return useQuery({
    queryKey: ['workspace', slug],
    queryFn: () => {
      if (!slug) throw new Error('slug is required');
      return fetchWorkspaceBySlug(slug);
    },
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
