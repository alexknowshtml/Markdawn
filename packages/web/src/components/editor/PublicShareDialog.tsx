import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { ShareEntityType, SharePermission } from '@markdawn/shared';
import { Check, Copy, Globe2, Info, Lock, Mail, Shield, UserRound, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import {
  useInviteToEntity,
  useRemoveShare,
  useShareSummary,
  useUpdateInheritancePolicy,
  useUpdateLinkPermission,
  useUpdateSharePermission,
} from '../../hooks/use-share';
import { useAuth } from '../../hooks/useAuth';
import { getInitial } from '../../utils/avatar';
import { consumeSelfLeave, markSelfLeave } from '../../utils/leave-page';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { ChoiceGroup, Dropdown, TextBox } from '../ui/FormControls';

type PublicShareDialogProps = {
  entityType: ShareEntityType;
  entityId: string;
  title: string;
  onClose: () => void;
  /** Render inline without floating dialog wrapper */
  embedded?: boolean;
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
  avatarUrl: string | null;
  permission: SharePermission;
  source: string;
  isOwner: boolean;
};

export function PublicShareDialog({
  entityType,
  entityId,
  title,
  onClose,
  embedded = false,
}: PublicShareDialogProps) {
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const [email, setEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<SharePermission>('view');
  const [copied, setCopied] = useState(false);

  const { data: summary, isLoading } = useShareSummary(entityType, entityId);
  const updateLinkMutation = useUpdateLinkPermission();
  const updateInheritanceMutation = useUpdateInheritancePolicy();
  const inviteMutation = useInviteToEntity();
  const removeShareMutation = useRemoveShare();
  const updatePermissionMutation = useUpdateSharePermission();

  const isOwner = summary?.entity.ownerId === currentUserId;
  const isAdmin = summary?.userPermission === 'admin';
  const canInvite = isOwner || isAdmin;

  const accessEntries: AccessEntry[] = (summary?.accessors ?? []).map((accessor) => ({
    shareId: accessor.shareId,
    id: accessor.userId,
    name: accessor.name ?? accessor.email ?? 'Unknown user',
    avatarUrl: accessor.avatarUrl ?? null,
    permission: accessor.permission,
    source: accessor.source,
    isOwner: accessor.isOwner,
  }));

  const linkUrl = summary?.link.url ? `${window.location.origin}${summary.link.url}` : '';
  const isRestricted = (summary?.inheritance?.policy ?? 'inherit') === 'restricted';

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

  const handleInvite = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    inviteMutation.mutate(
      { entityType, entityId, email: trimmed, permission: invitePermission },
      { onSuccess: () => setEmail('') },
    );
  };

  const handleRemove = (shareId: string) => {
    removeShareMutation.mutate(shareId);
  };

  const handleToggleRestriction = () => {
    if (!canInvite) return;
    updateInheritanceMutation.mutate({
      entityType,
      entityId,
      policy: isRestricted ? 'inherit' : 'restricted',
    });
  };

  const { refs, context } = useFloating({
    open: true,
    onOpenChange: () => onClose(),
  });

  const dismiss = useDismiss(context, { outsidePressEvent: 'mousedown' });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const [infoOpen, setInfoOpen] = useState(false);
  const {
    refs: infoRefs,
    floatingStyles: infoFloatingStyles,
    context: infoContext,
  } = useFloating({
    open: infoOpen,
    onOpenChange: setInfoOpen,
    placement: 'top',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });
  const infoHover = useHover(infoContext, { move: false });
  const infoFocus = useFocus(infoContext);
  const infoDismiss = useDismiss(infoContext);
  const infoRole = useRole(infoContext, { role: 'tooltip' });
  const infoInteractions = useInteractions([infoHover, infoFocus, infoDismiss, infoRole]);

  const [linkHelpOpen, setLinkHelpOpen] = useState(false);
  const {
    refs: linkHelpRefs,
    floatingStyles: linkHelpFloatingStyles,
    context: linkHelpContext,
  } = useFloating({
    open: linkHelpOpen,
    onOpenChange: setLinkHelpOpen,
    placement: 'top',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });
  const linkHelpHover = useHover(linkHelpContext, { move: false });
  const linkHelpFocus = useFocus(linkHelpContext);
  const linkHelpDismiss = useDismiss(linkHelpContext);
  const linkHelpRole = useRole(linkHelpContext, { role: 'tooltip' });
  const linkHelpInteractions = useInteractions([
    linkHelpHover,
    linkHelpFocus,
    linkHelpDismiss,
    linkHelpRole,
  ]);

  const formatSource = (source: string, entry: AccessEntry) => {
    if (entry.isOwner) return 'Owner';
    if (source === 'Direct Invite' || source === 'Email') return 'Direct Invite';
    if (source === 'Workspace Member' || source === 'workspace') return 'Workspace Member';
    if (source === 'Link') return 'Link Share';
    if (source.startsWith('via ')) return source;
    return source;
  };

  // ── Content rendered both floating and embedded ────────────────
  const content = (
    <div className="space-y-0">
      {canInvite && (
        <>
          <form
            onSubmit={handleInvite}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className="space-y-2"
          >
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
                  data-testid="share-email-input"
                />
                <Dropdown
                  value={invitePermission}
                  onChange={setInvitePermission}
                  options={[
                    { value: 'view', label: 'View' },
                    { value: 'edit', label: 'Edit' },
                    ...(isOwner ? [{ value: 'admin' as const, label: 'Admin' }] : []),
                  ]}
                  className="w-fit"
                  triggerClassName="px-2"
                />
                <button
                  type="submit"
                  disabled={inviteMutation.isPending || !email.trim()}
                  data-testid="share-invite-btn"
                  className="inline-flex h-6 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:border-zinc-300 disabled:cursor-default disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900 dark:hover:border-zinc-700 cursor-pointer"
                >
                  Invite
                </button>
              </div>
            </div>
          </form>

          <div className="flex items-center justify-between px-0 py-1 mt-4">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-zinc-500 dark:text-zinc-400" />
              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                Restrict inherited access
              </span>
              <button
                type="button"
                ref={infoRefs.setReference}
                {...infoInteractions.getReferenceProps()}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer"
              >
                <Info size={13} />
              </button>
              {infoOpen && (
                <FloatingPortal>
                  <div
                    ref={infoRefs.setFloating}
                    style={infoFloatingStyles}
                    {...infoInteractions.getFloatingProps()}
                    className="z-[9999] max-w-[320px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-zinc-600 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
                  >
                    When enabled, only people you directly add can access this {entityType}.
                    Inherited access won't work.
                  </div>
                </FloatingPortal>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isRestricted}
              onClick={handleToggleRestriction}
              disabled={updateInheritanceMutation.isPending}
              data-testid="share-restrict-toggle"
              className={`relative h-[22px] w-[40px] rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                isRestricted ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
              }`}
            >
              <span
                className={`absolute top-[3px] left-[3px] h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform ${
                  isRestricted ? 'translate-x-[18px]' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="h-4" />
        </>
      )}

      <div className="space-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            {summary?.link.permission === 'private' ? <Lock size={16} /> : <Globe2 size={16} />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Link access</p>
          </div>
        </div>
        <div
          ref={!canInvite && !isLoading ? linkHelpRefs.setReference : undefined}
          {...(!canInvite && !isLoading ? linkHelpInteractions.getReferenceProps() : {})}
          data-testid="share-link-permissions"
        >
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
          {summary?.link.permission === 'edit' && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              No sign-in is required. Anyone who receives this link can change the content.
            </p>
          )}
          {linkHelpOpen && !canInvite && !isLoading && (
            <FloatingPortal>
              <div
                ref={linkHelpRefs.setFloating}
                style={linkHelpFloatingStyles}
                {...linkHelpInteractions.getFloatingProps()}
                className="z-[9999] max-w-[280px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-zinc-600 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
              >
                You can see this link access, but you need admin access to change it.
              </div>
            </FloatingPortal>
          )}
        </div>
        {linkUrl && (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-zinc-500 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden dark:text-zinc-400">
                {linkUrl}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                data-testid="share-copy-link-btn"
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
          <div className="grid grid-cols-[minmax(0,1.2fr)_0.5fr_0.7fr] gap-2 border-b border-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <span>Name</span>
            <span>Access</span>
            <span>Source</span>
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

              return (
                <div
                  key={entry.id}
                  className="grid grid-cols-[minmax(0,1.2fr)_0.5fr_0.7fr] items-center gap-2 border-b border-zinc-200 px-3 py-1.5 last:border-b-0 dark:border-zinc-800"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full overflow-hidden"
                      style={{
                        backgroundColor: entry.avatarUrl ? undefined : '#71717a',
                      }}
                    >
                      {entry.avatarUrl ? (
                        <img
                          src={entry.avatarUrl}
                          alt={entry.name}
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="text-[9px] font-bold text-white">
                          {getInitial(entry.name)}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-zinc-900 dark:text-zinc-100 truncate max-w-[18ch]">
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
                        ...(isOwner ? [{ value: 'admin' as const, label: 'Admin' }] : []),
                        { value: 'remove', label: 'Remove' },
                      ]}
                      onChange={(permission) => {
                        if (permission === 'remove') {
                          if (canSelfRemove && entry.shareId) {
                            if (window.confirm('Are you sure you want to leave?')) {
                              handleRemove(entry.shareId);
                            }
                          } else if (entry.shareId) {
                            handleRemove(entry.shareId);
                          }
                        } else if (entry.shareId) {
                          updatePermissionMutation.mutate({
                            shareId: entry.shareId,
                            permission,
                          });
                        }
                      }}
                      className="w-fit"
                      triggerClassName="px-1.5 text-xs"
                    />
                  ) : canSelfRemove && entry.shareId ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm('Are you sure you want to leave?')) return;
                        if (entityType === 'page') markSelfLeave(entityId);
                        removeShareMutation.mutate(entry.shareId as string, {
                          onError: () => {
                            if (entityType === 'page') consumeSelfLeave(entityId);
                          },
                        });
                      }}
                      className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 cursor-pointer"
                    >
                      Leave
                    </button>
                  ) : (
                    <span className="text-xs text-zinc-600 dark:text-zinc-300">
                      {entry.permission === 'admin'
                        ? 'Admin'
                        : entry.permission === 'edit'
                          ? 'Edit'
                          : 'View'}
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                    {formatSource(entry.source, entry)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return <div data-testid="share-dialog-embedded">{content}</div>;
  }

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className="bg-zinc-900/40 backdrop-blur-sm grid place-items-center z-50 px-4"
      >
        <FloatingFocusManager context={context}>
          <div
            ref={refs.setFloating}
            {...getFloatingProps()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="dialog"
            data-testid="share-dialog"
            className="w-full max-w-lg flex max-h-[min(620px,calc(100vh-96px))] flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-scale-in"
          >
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2
                    id="share-dialog-title"
                    className="text-sm font-semibold text-zinc-950 dark:text-zinc-50"
                  >
                    Share {title || entityType}
                  </h2>
                  <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    Invite people or create a link for this {entityType}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  data-testid="share-close-btn"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                  aria-label="Close sharing panel"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto px-4 py-3.5">{content}</div>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
