import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isBulkRemovalInProgress } from '../utils/bulkRemovalState';
import { showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

export type WorkspaceMembership = {
  ownerId: string;
  ownerName: string | null;
  role: 'viewer' | 'editor' | 'admin';
  joinedAt: string;
};

export type WorkspaceMember = {
  id: string;
  workspace_owner_id: string;
  member_id: string;
  member_name: string | null;
  member_email: string;
  member_avatar_url: string | null;
  role: 'viewer' | 'editor' | 'admin';
  created_at: string;
};

async function fetchWorkspaceMembers(): Promise<WorkspaceMember[]> {
  const res = await fetch(`${API_BASE}/workspace/members`);
  if (!res.ok) throw new Error('Failed to fetch workspace members');
  return res.json();
}

export function useWorkspaceMembers() {
  return useQuery({
    queryKey: ['workspace-members'],
    queryFn: fetchWorkspaceMembers,
    staleTime: 1000 * 60,
    refetchOnWindowFocus: () => (isBulkRemovalInProgress() ? false : 'always'),
    refetchOnReconnect: () => (isBulkRemovalInProgress() ? false : 'always'),
    refetchInterval: () => (isBulkRemovalInProgress() ? false : 30_000),
    refetchIntervalInBackground: true,
  });
}

async function fetchWorkspaceMemberships(): Promise<WorkspaceMembership[]> {
  const res = await fetch(`${API_BASE}/workspace/memberships`);
  if (!res.ok) throw new Error('Failed to fetch joined workspaces');
  return res.json();
}

export function useWorkspaceMemberships() {
  return useQuery({
    queryKey: ['workspace-memberships'],
    queryFn: fetchWorkspaceMemberships,
    staleTime: 1000 * 60,
    refetchOnWindowFocus: () => !isBulkRemovalInProgress(),
    refetchOnReconnect: () => !isBulkRemovalInProgress(),
  });
}

export function invalidateWorkspaceAccessQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
  queryClient.invalidateQueries({ queryKey: ['workspace-memberships'] });
  queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
  queryClient.invalidateQueries({ queryKey: ['pageTree'] });
  queryClient.invalidateQueries({ queryKey: ['folderTree'] });
  queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
  queryClient.invalidateQueries({ queryKey: ['favorites'] });
  queryClient.invalidateQueries({ queryKey: ['shares'] });
  queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
  queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
}

async function inviteToWorkspace({
  email,
  role,
}: {
  email: string;
  role: 'viewer' | 'editor' | 'admin';
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/workspace/members/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to invite' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useInviteToWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inviteToWorkspace,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to invite' },
  });
}

async function changeMemberRole({
  memberId,
  role,
}: {
  memberId: string;
  role: 'viewer' | 'editor' | 'admin';
}): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/workspace/members/${memberId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to change role' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useChangeMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: changeMemberRole,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to change role' },
  });
}

async function removeWorkspaceMember(memberId: string): Promise<{ message?: string }> {
  const res = await fetch(`${API_BASE}/workspace/members/${memberId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove member');
  return res.json();
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeWorkspaceMember,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      queryClient.invalidateQueries({ queryKey: ['pageCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['folderCollaborators'] });
      queryClient.invalidateQueries({ queryKey: ['shares'] });
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to remove member' },
  });
}

async function leaveWorkspace({
  ownerId,
  memberId,
}: {
  ownerId: string;
  memberId: string;
}): Promise<{ message?: string }> {
  const res = await fetch(
    `${API_BASE}/workspace/members/${memberId}?workspaceOwnerId=${encodeURIComponent(ownerId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to leave workspace' }));
    throw new Error(error.message);
  }
  return res.json();
}

export function useLeaveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: leaveWorkspace,
    onSuccess: (data) => {
      invalidateWorkspaceAccessQueries(queryClient);
      if (data?.message) showSuccessToast(data.message);
    },
    meta: { errorMessage: 'Failed to leave workspace' },
  });
}
