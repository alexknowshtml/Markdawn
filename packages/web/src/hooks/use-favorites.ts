import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast } from '../utils/toast';

const API_BASE = '/api';

export interface Favorite {
  pageId: string;
  title: string;
  icon: string | null;
  createdAt: string | null;
}

async function fetchFavorites(): Promise<Favorite[]> {
  const res = await fetch(`${API_BASE}/favorites`);
  if (!res.ok) {
    throw new Error('Failed to fetch favorites');
  }
  const data = await res.json();
  return data.favorites;
}

async function addFavorite(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId }),
  });
  if (!res.ok) {
    throw new Error('Failed to add favorite');
  }
}

async function removeFavorite(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/favorites/${pageId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to remove favorite');
  }
}

export function useFavorites() {
  return useQuery({
    queryKey: ['favorites'],
    queryFn: () => fetchFavorites(),
    staleTime: 1000 * 60 * 5,
  });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ pageId, isFavorite }: { pageId: string; isFavorite: boolean }) => {
      if (isFavorite) {
        await removeFavorite(pageId);
      } else {
        await addFavorite(pageId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
    onError: () => {
      showErrorToast('Failed to update favorite');
    },
  });
}
