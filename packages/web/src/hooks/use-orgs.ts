import { useQuery } from '@tanstack/react-query';

export interface OrgWorkspace {
  id: string;
  name: string;
  slug: string;
  role: string | null;
}

export interface OrgWithWorkspaces {
  id: string;
  name: string;
  slug: string;
  role: string;
  workspaces: OrgWorkspace[];
}

async function fetchOrgsMine(): Promise<OrgWithWorkspaces[]> {
  const res = await fetch('/api/orgs/mine');
  if (!res.ok) throw new Error('Failed to fetch orgs');
  return res.json();
}

export function useOrgsMine() {
  return useQuery({
    queryKey: ['orgs-mine'],
    queryFn: fetchOrgsMine,
    staleTime: 1000 * 60 * 5,
  });
}
