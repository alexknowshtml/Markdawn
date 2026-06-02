import type { ShareEntityType, SharePermission } from '@markdawn/shared';
import { Check, Copy, Globe2, Lock, Mail, Trash2, UserRound, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useInviteToEntity,
  useRemoveShare,
  useShareSummary,
  useUpdateLinkPermission,
  useUpdateSharePermission,
} from '../../hooks/use-share';
import { useAuth } from '../../hooks/useAuth';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { ChoiceGroup, Dropdown, TextBox } from '../ui/FormControls';

type PublicShareDialogProps = {
  entityType: ShareEntityType;
  entityId: string;
  title: string;
  anchorRect?: DOMRect | null;
  onClose: () => void;
};

const permissionOptions: Array<{ value: SharePermission | 'private'; label: string }> = [
  { value: 'private', label: 'Restricted' },
  { value: 'view', label: 'Anyone Can View' },
  { value: 'edit', label: 'Anyone Can Edit' },
];

type AccessEntry = {
  shareId: string | null;
  id: string;
  name: string;
  permission: SharePermission;
  isOwner: boolean;
};

export function PublicShareDialog({
  entityType,
  entityId,
  title,
  anchorRect,
  onClose,
}: PublicShareDialogProps) {
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const [email, setEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<SharePermission>('view');
  const [copied, setCopied] = useState(false);
  const [leaveConfirmId, setLeaveConfirmId] = useState<string | null>(null);
  const [isRestricted, setIsRestricted] = useState(false);
  const { data: summary, isLoading } = useShareSummary(entityType, entityId);
  const updateLinkMutation = useUpdateLinkPermission();
  const inviteMutation = useInviteToEntity();
  const removeShareMutation = useRemoveShare();
  const updatePermissionMutation = useUpdateSharePermission();

  const canShare = summary?.capabilities?.canShare ?? false;
  const isOwner = summary?.entity.ownerId === currentUserId;
  const isAdmin = summary?.userPermission === 'admin';
  const canInvite = isOwner || isAdmin;

  const overlayStyle: React.CSSProperties = anchorRect
    ? {
        left: `${Math.max(16, anchorRect.right - 440)}px`,
        top: `${Math.min(anchorRect.bottom + 10, window.innerHeight - 520)}px`,
      }
    : {
        right: '24px',
        top: '72px',
      };

  const accessEntries: AccessEntry[] = (summary?.accessors ?? []).map((accessor) => ({
    shareId: accessor.shareId,
    id: accessor.userId,
    name: accessor.name ?? accessor.email ?? 'Unknown user',
    permission: accessor.permission,
    isOwner: accessor.isOwner,
  }));

  const linkUrl = summary?.link.url ? `${window.location.origin}${summary.link.url}` : '';

  const handleCopy = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      showSuccessToast('Link copied');
    } catch {
      showErrorToast('Failed to copy link');
    }
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    try {
      await inviteMutation.mutateAsync({
        entityType,
        entityId,
        email: trimmed,
        permission: invitePermission,
      });
      setEmail('');
    } catch {
      // Error handled by mutation's onError handler — prevents unhandled promise rejection
    }
  };

  const handleRemove = (shareId: string) => {
    removeShareMutation.mutate(shareId, {
      onSuccess: () => {
        setLeaveConfirmId(null);
      },
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 pointer-events-none">
      <button
        type="button"
        aria-label="Close sharing panel"
        className="absolute inset-0 cursor-default pointer-events-auto"
        onClick={onClose}
      />
      <div
        style={overlayStyle}
        className="absolute pointer-events-auto flex max-h-[min(620px,calc(100vh-96px))] w-[min(440px,calc(100vw-32px))] flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-scale-in"
      >
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                Share {title || entityType}
              </h2>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                Invite people or create a link for this {entityType}.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
              aria-label="Close sharing panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-4 py-3.5">
          <div className="space-y-0">
            {canInvite && (
              <>
                <form onSubmit={handleInvite} className="space-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      <Mail size={16} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Invite access
                      </p>
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                    <div className="grid gap-0 sm:grid-cols-[minmax(0,1fr)_5rem_auto] sm:items-center">
                      <TextBox
                        type="email"
                        value={email}
                        onChange={setEmail}
                        placeholder="Enter email"
                        className="h-6"
                        inputClassName="h-6 py-0 text-sm"
                      />
                      <Dropdown
                        value={invitePermission}
                        onChange={setInvitePermission}
                        options={[
                          { value: 'view', label: 'View' },
                          { value: 'edit', label: 'Edit' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                        className="w-fit"
                        triggerClassName="px-2"
                      />
                      <button
                        type="submit"
                        disabled={inviteMutation.isPending || !email.trim()}
                        className="inline-flex h-6 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:border-zinc-300 disabled:cursor-default disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900 dark:hover:border-zinc-700 cursor-pointer"
                      >
                        Invite
                      </button>
                    </div>
                  </div>
                </form>

                <div className="h-4" />
              </>
            )}

            {canShare && entityType === 'folder' && (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <Lock size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Workspace access
                    </p>
                  </div>
                </div>
                <label className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40 cursor-pointer">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-900 dark:text-zinc-100">
                      Restrict workspace access
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      Workspace members cannot access this folder unless invited directly.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isRestricted}
                    onClick={async () => {
                      const next = !isRestricted;
                      try {
                        const res = await fetch(`/api/folders/${entityId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ isAccessRestricted: next }),
                        });
                        if (!res.ok) throw new Error();
                        setIsRestricted(next);
                        showSuccessToast(
                          next ? 'Workspace access restricted' : 'Workspace access restored',
                        );
                      } catch {
                        showErrorToast('Failed to update folder access');
                      }
                    }}
                    className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${
                      isRestricted ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        isRestricted ? 'translate-x-[18px]' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </label>
                <div className="h-4" />
              </>
            )}

            <div className="space-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  {summary?.link.permission === 'private' ? (
                    <Lock size={16} />
                  ) : (
                    <Globe2 size={16} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Link access
                  </p>
                </div>
              </div>
              <ChoiceGroup
                value={summary?.link.permission ?? 'private'}
                options={permissionOptions}
                disabled={isLoading || !canInvite || updateLinkMutation.isPending}
                onChange={(permission) =>
                  updateLinkMutation.mutate({
                    entityType,
                    entityId,
                    permission,
                  })
                }
                className="w-full justify-between"
              />
              {linkUrl && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-zinc-500 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden dark:text-zinc-400">
                      {linkUrl}
                    </div>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 cursor-pointer"
                      title="Copy link"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="h-4" />

            <div className="space-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <UserRound size={16} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    People with access
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                <div className="grid grid-cols-[minmax(0,1.4fr)_0.7fr_2rem] gap-2 border-b border-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <span>Name</span>
                  <span>Access type</span>
                  <span />
                </div>
                {accessEntries.length === 0 ? (
                  <p className="px-3 py-2.5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                    No one has access yet.
                  </p>
                ) : (
                  accessEntries.map((entry) => {
                    const isCurrentUser = entry.id === currentUserId;
                    const displayName = isCurrentUser ? 'You' : entry.name;
                    const isTargetOwner = entry.isOwner;
                    const isTargetAdmin = entry.permission === 'admin';
                    const canChangePermission =
                      canInvite &&
                      !isTargetOwner &&
                      !(summary?.userPermission === 'admin' && isTargetAdmin);
                    const canSelfRemove = isCurrentUser && !isTargetOwner && entry.shareId;
                    const showRemove = canChangePermission || canSelfRemove;
                    const isLeaveConfirm = leaveConfirmId === entry.id;

                    return (
                      <div
                        key={entry.id}
                        className="grid grid-cols-[minmax(0,1.4fr)_0.7fr_2rem] items-center gap-2 border-b border-zinc-200 px-3 py-1.5 last:border-b-0 dark:border-zinc-800"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                            {displayName}
                          </p>
                        </div>
                        {entry.isOwner ? (
                          <span className="text-xs text-zinc-600 dark:text-zinc-300">Owner</span>
                        ) : entry.shareId && canChangePermission ? (
                          <Dropdown
                            value={entry.permission}
                            options={[
                              { value: 'view', label: 'View' },
                              { value: 'edit', label: 'Edit' },
                              { value: 'admin', label: 'Admin' },
                            ]}
                            onChange={(permission) => {
                              if (entry.shareId) {
                                updatePermissionMutation.mutate({
                                  shareId: entry.shareId,
                                  permission,
                                });
                              }
                            }}
                            className="w-fit"
                            triggerClassName="px-1.5 text-xs"
                          />
                        ) : (
                          <span className="text-xs text-zinc-600 dark:text-zinc-300">
                            {entry.permission === 'admin'
                              ? 'Admin'
                              : entry.permission === 'edit'
                                ? 'Edit'
                                : 'View'}
                          </span>
                        )}
                        <div className="flex items-center justify-end">
                          {showRemove &&
                            (isLeaveConfirm ? (
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                  Leave?
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (entry.shareId) {
                                      handleRemove(entry.shareId);
                                    }
                                  }}
                                  disabled={removeShareMutation.isPending}
                                  className="flex h-5 items-center rounded-md bg-red-50 px-1.5 text-[10px] font-medium text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 disabled:opacity-40 cursor-pointer"
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setLeaveConfirmId(null)}
                                  className="flex h-5 items-center rounded-md bg-zinc-100 px-1.5 text-[10px] font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 cursor-pointer"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  if (canSelfRemove) {
                                    setLeaveConfirmId(entry.id);
                                  } else if (entry.shareId) {
                                    handleRemove(entry.shareId);
                                  }
                                }}
                                disabled={removeShareMutation.isPending}
                                className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800 dark:hover:text-red-400 disabled:opacity-40 cursor-pointer"
                                title={canSelfRemove ? 'Leave' : 'Remove access'}
                              >
                                <Trash2 size={14} />
                              </button>
                            ))}
                          {isTargetOwner && !showRemove && (
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                              Owner
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
