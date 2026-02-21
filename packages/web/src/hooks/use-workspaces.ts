import { useQuery } from '@tanstack/react-query';
import { Workspace } from '@markdawn/shared';

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
    queryFn: () => fetchWorkspaceBySlug(slug!),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
