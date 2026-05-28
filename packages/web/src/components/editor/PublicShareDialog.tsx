import type { ShareEntityType, SharePermission } from '@markdawn/shared';
import { Check, Copy, Globe2, Lock, Mail, Trash2, UserRound, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import {
  useInviteToEntity,
  useRemoveShare,
  useShareSummary,
  useUpdateLinkPermission,
} from '../../hooks/use-share';
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
  source: string;
};

export function PublicShareDialog({
  entityType,
  entityId,
  title,
  anchorRect,
  onClose,
}: PublicShareDialogProps) {
  const [email, setEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<SharePermission>('view');
  const [copied, setCopied] = useState(false);
  const { data: summary, isLoading } = useShareSummary(entityType, entityId);
  const updateLinkMutation = useUpdateLinkPermission();
  const inviteMutation = useInviteToEntity();
  const removeShareMutation = useRemoveShare();

  const overlayStyle: React.CSSProperties = anchorRect
    ? {
        left: `${Math.min(Math.max(16, anchorRect.right - 440), window.innerWidth - 456)}px`,
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
    source: accessor.source,
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
    await inviteMutation.mutateAsync({
      entityType,
      entityId,
      email: trimmed,
      permission: invitePermission,
    });
    setEmail('');
  };

  return (
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
                disabled={isLoading || updateLinkMutation.isPending}
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
                <div className="grid grid-cols-[minmax(0,1.4fr)_0.7fr_0.6fr_2rem] gap-2 border-b border-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <span>Name</span>
                  <span>Access type</span>
                  <span>Source</span>
                  <span />
                </div>
                {accessEntries.length === 0 ? (
                  <p className="px-3 py-2.5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                    No one has access yet.
                  </p>
                ) : (
                  accessEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid grid-cols-[minmax(0,1.4fr)_0.7fr_0.6fr_2rem] items-center gap-2 border-b border-zinc-200 px-3 py-1.5 last:border-b-0 dark:border-zinc-800"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                          {entry.name}
                        </p>
                      </div>
                      <span className="text-xs text-zinc-600 dark:text-zinc-300">
                        {entry.permission === 'edit' ? 'Edit' : 'View'}
                      </span>
                      <span className="text-xs text-zinc-600 dark:text-zinc-300">
                        {entry.source}
                      </span>
                      {entry.shareId && (
                        <button
                          type="button"
                          onClick={() => {
                            const shareId = entry.shareId;
                            if (shareId) {
                              removeShareMutation.mutate(shareId, {
                                onSuccess: () => {
                                  showSuccessToast('Access removed');
                                },
                              });
                            }
                          }}
                          disabled={removeShareMutation.isPending}
                          className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800 dark:hover:text-red-400 disabled:opacity-40 cursor-pointer"
                          title="Remove access"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
