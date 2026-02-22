import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { showSuccessToast, showErrorToast } from '../utils/toast';

const API_BASE = '/api';

export interface PageVersion {
  id: string;
  pageId: string;
  title: string | null;
  createdAt: string | null;
  createdByName: string | null;
}

async function fetchVersions(pageId: string): Promise<PageVersion[]> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/versions`);
  if (!res.ok) {
    throw new Error('Failed to fetch versions');
  }
  return res.json();
}

async function createVersion(pageId: string, title: string): Promise<PageVersion> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error('Failed to create version');
  }
  return res.json();
}

async function restoreVersion(pageId: string, versionId: string): Promise<{ id: string; title: string | null }> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/versions/${versionId}/restore`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error('Failed to restore version');
  }
  return res.json();
}

export function useVersions(pageId: string | undefined) {
  return useQuery({
    queryKey: ['versions', pageId],
    queryFn: () => fetchVersions(pageId!),
    enabled: !!pageId,
  });
}

export function useCreateVersion(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => createVersion(pageId!, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['versions', pageId] });
      showSuccessToast('Snapshot saved');
    },
    onError: () => {
      showErrorToast('Failed to save snapshot');
    },
  });
}

export function useRestoreVersion(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => restoreVersion(pageId!, versionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['versions', pageId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      showSuccessToast('Version restored');
    },
    onError: () => {
      showErrorToast('Failed to restore version');
    },
  });
}
