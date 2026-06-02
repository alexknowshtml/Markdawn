import { useQueryClient } from '@tanstack/react-query';
import { Download, FolderOpen, Mail, Shield, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ObsidianImportDialog } from '../components/import/ObsidianImportDialog';
import {
  useChangeMemberRole,
  useInviteToWorkspace,
  useRemoveWorkspaceMember,
  useWorkspaceMembers,
} from '../hooks/use-workspace';
import { useAuth } from '../hooks/useAuth';
import { showErrorToast, showSuccessToast } from '../utils/toast';

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');

  const { data: members, isLoading: membersLoading } = useWorkspaceMembers();
  const inviteMutation = useInviteToWorkspace();
  const changeRoleMutation = useChangeMemberRole();
  const removeMemberMutation = useRemoveWorkspaceMember();
  const isOwner = members?.some((m) => m.workspace_owner_id === currentUserId);

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    try {
      await inviteMutation.mutateAsync({ email: trimmed, role: inviteRole });
      setInviteEmail('');
    } catch {
      // Error handled by mutation
    }
  };

  const handleExportAll = async () => {
    setIsExporting(true);
    try {
      const res = await fetch('/api/pages/export/all');
      if (!res.ok) throw new Error('Failed to export');
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition');
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? 'pages-export.zip';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccessToast('Pages exported');
    } catch {
      showErrorToast('Failed to export pages');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          to="/app"
          className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Back to home
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Manage your account and data.
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Workspace members
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Invite people to collaborate on your workspace. Members can view and edit all pages
              unless access is restricted.
            </p>
          </div>
        </div>

        {/* Invite form */}
        <form onSubmit={handleInvite} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="Enter email address"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            className="h-9 px-3 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            disabled={inviteMutation.isPending || !inviteEmail.trim()}
            className="inline-flex h-9 items-center gap-1.5 px-4 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors disabled:opacity-60 cursor-pointer"
          >
            <UserPlus size={14} />
            Invite
          </button>
        </form>

        {/* Members list */}
        {membersLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
            ))}
          </div>
        ) : members && members.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <div className="grid grid-cols-[minmax(0,1.4fr)_0.5fr_1fr_2rem] gap-2 border-b border-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <span>Name</span>
              <span>Role</span>
              <span>Email</span>
              <span />
            </div>
            {members.map((member) => {
              const isCurrentUser = member.member_id === currentUserId;
              const isOwnerUser = member.member_id === member.workspace_owner_id;
              return (
                <div
                  key={member.id}
                  className="grid grid-cols-[minmax(0,1.4fr)_0.5fr_1fr_2rem] items-center gap-2 border-b border-zinc-200 px-3 py-2 last:border-b-0 dark:border-zinc-800"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-6 w-6 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-[10px] font-medium text-zinc-600 dark:text-zinc-300 shrink-0">
                      {member.member_name?.charAt(0)?.toUpperCase() ?? '?'}
                    </div>
                    <span className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                      {isCurrentUser ? 'You' : (member.member_name ?? 'Unknown')}
                    </span>
                  </div>
                  <div>
                    {isOwnerUser ? (
                      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                        Owner
                      </span>
                    ) : isOwner && !isCurrentUser ? (
                      <select
                        value={member.role}
                        onChange={(e) =>
                          changeRoleMutation.mutate({
                            memberId: member.member_id,
                            role: e.target.value as 'member' | 'admin',
                          })
                        }
                        className="text-xs rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300 focus:outline-none"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="text-xs capitalize text-zinc-600 dark:text-zinc-300">
                        {member.role}
                      </span>
                    )}
                  </div>
                  <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {member.member_email}
                  </span>
                  <div className="flex items-center justify-end">
                    {isOwner && !isOwnerUser && !isCurrentUser && (
                      <button
                        type="button"
                        onClick={() => removeMemberMutation.mutate(member.member_id)}
                        disabled={removeMemberMutation.isPending}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800 dark:hover:text-red-400 disabled:opacity-40 cursor-pointer"
                        title="Remove member"
                      >
                        <UserMinus size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-4">
            No workspace members yet. Invite someone to collaborate.
          </p>
        )}

        {isOwner && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 px-3 py-2">
            <Shield size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              You are the workspace owner. Admins can invite members but cannot remove other admins
              or the owner.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Import Obsidian vault
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Import your entire Obsidian vault including notes, images, tags, and backlinks.
          </p>
        </div>
        <div>
          <button
            type="button"
            onClick={() => setShowImportDialog(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors cursor-pointer"
          >
            <FolderOpen size={16} />
            Import Vault
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Export all pages
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Download all pages as markdown files in a zip.
          </p>
        </div>
        <div>
          <button
            type="button"
            onClick={handleExportAll}
            disabled={isExporting}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors disabled:opacity-60 cursor-pointer"
          >
            <Download size={16} />
            {isExporting ? 'Exporting...' : 'Export All Pages'}
          </button>
        </div>
      </section>

      {showImportDialog && (
        <ObsidianImportDialog
          onClose={() => setShowImportDialog(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['pageTree'] });
            queryClient.invalidateQueries({ queryKey: ['folderTree'] });
            queryClient.invalidateQueries({ queryKey: ['tags'] });
          }}
        />
      )}
    </div>
  );
}
