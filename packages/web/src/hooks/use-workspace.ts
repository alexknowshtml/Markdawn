import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

export type WorkspaceMember = {
  id: string;
  workspace_owner_id: string;
  member_id: string;
  member_name: string | null;
  member_email: string;
  member_avatar_url: string | null;
  role: 'member' | 'admin';
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
  });
}

async function inviteToWorkspace({
  email,
  role,
}: {
  email: string;
  role: 'member' | 'admin';
}): Promise<void> {
  const res = await fetch(`${API_BASE}/workspace/members/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to invite' }));
    throw new Error(error.message);
  }
}

export function useInviteToWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inviteToWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      showSuccessToast('Member invited');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

async function changeMemberRole({
  memberId,
  role,
}: {
  memberId: string;
  role: 'member' | 'admin';
}): Promise<void> {
  const res = await fetch(`${API_BASE}/workspace/members/${memberId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to change role' }));
    throw new Error(error.message);
  }
}

export function useChangeMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: changeMemberRole,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      showSuccessToast('Role updated');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}

async function removeWorkspaceMember(memberId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/workspace/members/${memberId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove member');
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeWorkspaceMember,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
      showSuccessToast('Member removed');
    },
    onError: (error: Error) => {
      showErrorToast(error.message);
    },
  });
}
