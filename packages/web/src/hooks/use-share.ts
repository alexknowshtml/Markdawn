import type {
  InheritancePolicy,
  ShareEntityType,
  SharePermission,
  ShareSummary,
} from '@markdawn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isBulkRemovalInProgress } from '../utils/bulkRemovalState';
import { showSuccessToast } from '../utils/toast';

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
}): Promise<ShareSummary['link'] & { message?: string }> {
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

async function updateInheritancePolicy({
  entityType,
  entityId,
  policy,
}: {
  entityType: ShareEntityType;
  entityId: string;
  policy: InheritancePolicy;
}): Promise<{ policy: InheritancePolicy; message?: string }> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/inheritance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update inheritance' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function inviteToEntity({
  entityType,
  entityId,
  email,
  permission,
  expiresAt,
}: {
  entityType: ShareEntityType;
  entityId: string;
  email: string;
  permission: SharePermission;
  expiresAt?: string;
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, permission, expiresAt }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to invite user' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function removeShare(shareId: string): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/${shareId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to remove access');
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
    refetchOnMount: () => (isBulkRemovalInProgress() ? false : 'always'),
    refetchOnWindowFocus: () => (isBulkRemovalInProgress() ? false : 'always'),
    refetchOnReconnect: () => (isBulkRemovalInProgress() ? false : 'always'),
    refetchInterval: () => (isBulkRemovalInProgress() ? false : 30_000),
    refetchIntervalInBackground: true,
  });
}

export function useUpdateLinkPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateLinkPermission,
    onSuccess: (data, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to update link' },
  });
}

export function useUpdateInheritancePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateInheritancePolicy,
    onSuccess: (data, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to update inheritance' },
  });
}

export function useInviteToEntity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inviteToEntity,
    onSuccess: (data, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to invite user' },
  });
}

async function updateSharePermission({
  shareId,
  permission,
}: {
  shareId: string;
  permission: SharePermission;
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/${shareId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update permission' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useUpdateSharePermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSharePermission,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to update permission' },
  });
}

export function useRemoveShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeShare,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to remove access' },
  });
}
