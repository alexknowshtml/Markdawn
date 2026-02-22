import { useMutation, useQueryClient } from '@tanstack/react-query';
import { showSuccessToast, showErrorToast } from '../utils/toast';

const API_BASE = '/api';

async function sharePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/share`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error('Failed to share page');
  }
}

async function unsharePage(pageId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/share`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to unshare page');
  }
}

export function useSharePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => sharePage(pageId),
    onSuccess: (_, pageId) => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail', pageId] });
      showSuccessToast('Page shared publicly');
    },
    onError: () => {
      showErrorToast('Failed to share page');
    },
  });
}

export function useUnsharePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => unsharePage(pageId),
    onSuccess: (_, pageId) => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail', pageId] });
      showSuccessToast('Page is no longer public');
    },
    onError: () => {
      showErrorToast('Failed to unshare page');
    },
  });
}
