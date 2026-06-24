import type { SharedWithMeItem } from '@markdawn/shared';
import { useQuery } from '@tanstack/react-query';

const API_BASE = '/api';

async function fetchSharedWithMe(): Promise<SharedWithMeItem[]> {
  const res = await fetch(`${API_BASE}/shares/with-me`);
  if (!res.ok) {
    throw new Error('Failed to fetch shared content');
  }
  return res.json();
}

export function useSharedWithMe() {
  return useQuery({
    queryKey: ['shared-with-me'],
    queryFn: fetchSharedWithMe,
  });
}
