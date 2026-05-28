import type {
  SharedWithMeItem,
  ShareEntityType,
  SharePermission,
  ShareSummary,
} from '@markdawn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

type LinkPermission = SharePermission | 'private';

async function fetchShareSummary(
  entityType: ShareEntityType,
  entityId: string,
): Promise<ShareSummary> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch sharing settings');
  }
  return res.json();
}

async function updateLinkPermission({
  entityType,
  entityId,
  permission,
}: {
  entityType: ShareEntityType;
  entityId: string;
  permission: LinkPermission;
}): Promise<ShareSummary['link']> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/link`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update link' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function inviteToEntity({
  entityType,
  entityId,
  email,
  permission,
}: {
  entityType: ShareEntityType;
  entityId: string;
  email: string;
  permission: SharePermission;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, permission }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to invite user' }));
    throw new Error(error.message);
  }
}

async function removeShare(shareId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/shares/${shareId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to remove access');
  }
}

async function fetchSharedWithMe(): Promise<SharedWithMeItem[]> {
  const res = await fetch(`${API_BASE}/shares/with-me`);
  if (!res.ok) {
    throw new Error('Failed to fetch shared items');
  }
  return res.json();
}

export function useShareSummary(entityType: ShareEntityType, entityId?: string) {
  return useQuery({
    queryKey: ['shares', entityType, entityId],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchShareSummary(entityType, entityId);
    },
    enabled: !!entityId,
  });
}

export function useUpdateLinkPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateLinkPermission,
    onSuccess: (_, { entityType, entityId, permission }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail'] });
      showSuccessToast(permission === 'private' ? 'Link disabled' : 'Link access updated');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useInviteToEntity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inviteToEntity,
    onSuccess: (_, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      showSuccessToast('Access granted');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

export function useRemoveShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeShare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      showSuccessToast('Access removed');
    },
    onError: () => {
      showErrorToast('Failed to remove access');
    },
  });
}

export function useSharedWithMe() {
  return useQuery({
    queryKey: ['shared-with-me'],
    queryFn: fetchSharedWithMe,
    staleTime: 1000 * 60,
  });
}
