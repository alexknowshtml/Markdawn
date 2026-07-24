import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

export interface Backlink {
  id: string;
  sourcePageId: string;
  linkText: string;
  linkType: string;
  createdAt: string;
  sourceTitle: string;
  sourceIcon: string | null;
}

export interface OutgoingLink {
  id: string;
  targetPageId: string | null;
  targetTitle: string;
  linkText: string;
  linkType: string;
  targetState: 'accessible' | 'restricted' | 'unavailable';
  targetPageTitle: string | null;
  targetPageIcon: string | null;
}

async function fetchBacklinks(pageId: string): Promise<Backlink[]> {
  const res = await fetch(`${API_BASE}/backlinks?pageId=${encodeURIComponent(pageId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch backlinks');
  }
  return res.json();
}

async function fetchOutgoingLinks(pageId: string): Promise<OutgoingLink[]> {
  const res = await fetch(`${API_BASE}/backlinks/outgoing?pageId=${encodeURIComponent(pageId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch outgoing links');
  }
  return res.json();
}

export function useBacklinks(pageId?: string) {
  return useQuery({
    queryKey: ['backlinks', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchBacklinks(pageId);
    },
    enabled: !!pageId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useOutgoingLinks(pageId?: string) {
  return useQuery({
    queryKey: ['backlinks', 'outgoing', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchOutgoingLinks(pageId);
    },
    enabled: !!pageId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
