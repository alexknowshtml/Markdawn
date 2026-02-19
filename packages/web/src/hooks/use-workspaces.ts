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
  const res = await fetch(`${API_BASE}/workspaces?slug=${slug}`);
  if (!res.ok) {
    throw new Error('Failed to fetch workspace');
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    if (data.length === 0) throw new Error('Workspace not found');
    return data[0];
  }
  return data;
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
  });
}

export function useWorkspace(slug?: string) {
  return useQuery({
    queryKey: ['workspace', slug],
    queryFn: () => fetchWorkspaceBySlug(slug!),
    enabled: !!slug,
  });
}
