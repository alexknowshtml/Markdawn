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

type PublicPermission = Exclude<SharePermission, 'admin'> | 'private';

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

async function updatePublicPermission({
  entityType,
  entityId,
  permission,
}: {
  entityType: ShareEntityType;
  entityId: string;
  permission: PublicPermission;
}): Promise<ShareSummary['publicAccess'] & { message?: string }> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/public-access`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update public access' }));
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

async function grantEntityAccess({
  entityType,
  entityId,
  email,
  permission,
}: {
  entityType: ShareEntityType;
  entityId: string;
  email: string;
  permission: SharePermission;
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/entity/${entityType}/${entityId}/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, permission }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to grant access' }));
    throw new Error(error.message);
  }
  return res.json();
}

async function removeGrant(grantId: string): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/grants/${grantId}`, {
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

export function useUpdatePublicPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updatePublicPermission,
    onSuccess: (data, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'detail'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to update public access' },
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

export function useGrantEntityAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: grantEntityAccess,
    onSuccess: (data, { entityType, entityId }) => {
      queryClient.invalidateQueries({ queryKey: ['shares', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to grant access' },
  });
}

async function updateGrantPermission({
  grantId,
  permission,
}: {
  grantId: string;
  permission: SharePermission;
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/shares/grants/${grantId}`, {
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

export function useUpdateGrantPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateGrantPermission,
    onSuccess: (data) => {
      // A direct grant update can change which of several independent sources
      // wins. Refetch the server-computed provenance instead of locally
      // mutating only one source into an internally inconsistent summary.
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to update permission' },
  });
}

export function useRemoveGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeGrant,
    onSuccess: (data) => {
      // Removing one grant can promote a latent folder, workspace, or public
      // source. Only the API has enough context to recompute the winner.
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
