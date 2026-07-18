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
import { useIdentityLifecycle } from '../../contexts/IdentityLifecycleContext';
import {
  useGrantEntityAccess,
  useRemoveGrant,
  useShareSummary,
  useUpdateGrantPermission,
  useUpdateInheritancePolicy,
  useUpdatePublicPermission,
} from '../../hooks/use-share';
import { useAuth } from '../../hooks/useAuth';
import { getInitial } from '../../utils/avatar';
import { consumeSelfLeave, markSelfLeave } from '../../utils/leave-page';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { ChoiceGroup, Dropdown, TextBox } from '../ui/FormControls';

type ShareDialogProps = {
  entityType: ShareEntityType;
  entityId: string;
  title: string;
  onClose: () => void;
  /** Render inline without floating dialog wrapper */
  embedded?: boolean;
};

const permissionOptions: Array<{
  value: Exclude<SharePermission, 'admin'> | 'private';
  label: string;
}> = [
  { value: 'private', label: 'Restricted' },
  { value: 'view', label: 'Anyone Can View' },
  { value: 'edit', label: 'Anyone Can Edit' },
];

type AccessEntry = {
  key: string;
  grantId: string | null;
  id: string;
  name: string;
  avatarUrl: string | null;
  permission: SharePermission;
  effectivePermission: SharePermission;
  isWinning: boolean;
  isManageable: boolean;
  kind: 'owner' | 'direct' | 'folder' | 'workspace';
  source: string;
  isOwner: boolean;
};

export function ShareDialog({
  entityType,
  entityId,
  title,
  onClose,
  embedded = false,
}: ShareDialogProps) {
  const identityLifecycle = useIdentityLifecycle();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const [email, setEmail] = useState('');
  const [grantPermission, setGrantPermission] = useState<SharePermission>('view');
  const [copied, setCopied] = useState(false);

  const {
    data: summary,
    isLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useShareSummary(entityType, entityId);
  const updatePublicMutation = useUpdatePublicPermission();
  const updateInheritanceMutation = useUpdateInheritancePolicy();
  const grantMutation = useGrantEntityAccess();
  const removeGrantMutation = useRemoveGrant();
  const updateGrantPermissionMutation = useUpdateGrantPermission();

  const isOwner = summary?.entity.ownerId === currentUserId;
  const isAdmin = summary?.userPermission === 'admin';
  const canGrant = isOwner || isAdmin;
  const isLimitedSummary = summary?.visibility === 'limited';

  const accessEntries: AccessEntry[] = (summary?.accessSources ?? []).map((source, index) => ({
    key: `${source.kind}:${source.grantId ?? source.folderId ?? source.userId}:${index}`,
    grantId: source.grantId,
    id: source.userId,
    name: source.name ?? source.email ?? 'Unknown user',
    avatarUrl: source.avatarUrl ?? null,
    permission: source.permission,
    effectivePermission: source.effectivePermission,
    isWinning: source.isWinning,
    isManageable: source.isManageable,
    kind: source.kind,
    source: source.kind === 'folder' ? `via ${source.folderName ?? 'shared folder'}` : source.kind,
    isOwner: source.isOwner,
  }));

  const publicUrl = summary?.publicAccess.url
    ? `${window.location.origin}${summary.publicAccess.url}`
    : '';
  const inheritedPublicAccess = summary?.inheritedPublicAccess ?? [];
  const hasPublicAccess =
    summary?.publicAccess.permission !== 'private' || inheritedPublicAccess.length > 0;
  const isRestricted = (summary?.inheritance?.policy ?? 'inherit') === 'restricted';

  const handleCopy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      if (!identityLifecycle.isActive()) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      showSuccessToast('URL copied');
    } catch {
      if (!identityLifecycle.isActive()) return;
      showErrorToast('Failed to copy URL');
    }
  };

  const handleGrant = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    grantMutation.mutate(
      { entityType, entityId, email: trimmed, permission: grantPermission },
      { onSuccess: () => setEmail('') },
    );
  };

  const handleRemove = (grantId: string) => {
    removeGrantMutation.mutate(grantId);
  };

  const handleToggleRestriction = () => {
    if (!canGrant) return;
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

  const [accessHelpOpen, setAccessHelpOpen] = useState(false);
  const {
    refs: accessHelpRefs,
    floatingStyles: accessHelpFloatingStyles,
    context: accessHelpContext,
  } = useFloating({
    open: accessHelpOpen,
    onOpenChange: setAccessHelpOpen,
    placement: 'top',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });
  const accessHelpHover = useHover(accessHelpContext, { move: false });
  const accessHelpFocus = useFocus(accessHelpContext);
  const accessHelpDismiss = useDismiss(accessHelpContext);
  const accessHelpRole = useRole(accessHelpContext, { role: 'tooltip' });
  const accessHelpInteractions = useInteractions([
    accessHelpHover,
    accessHelpFocus,
    accessHelpDismiss,
    accessHelpRole,
  ]);

  const formatSource = (source: string, entry: AccessEntry) => {
    if (entry.isOwner) return 'Owner';
    if (entry.kind === 'direct') return 'Direct Grant';
    if (entry.kind === 'folder') return source;
    return 'Workspace Member';
  };

  // ── Content rendered both floating and embedded ────────────────
  const content =
    summaryError && !summary ? (
      <div
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20"
      >
        <p className="text-sm font-medium text-red-700 dark:text-red-300">
          Sharing settings couldn&apos;t be loaded.
        </p>
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Access has not been removed. Retry to see the current settings.
        </p>
        <button
          type="button"
          onClick={() => void refetchSummary()}
          className="mt-3 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/40 cursor-pointer"
        >
          Retry
        </button>
      </div>
    ) : (
      <div className="space-y-0">
        {canGrant && (
          <>
            <form
              onSubmit={handleGrant}
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
                    Grant access
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
                    aria-label="Existing user's email address"
                  />
                  <Dropdown
                    value={grantPermission}
                    onChange={setGrantPermission}
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
                    disabled={grantMutation.isPending || !email.trim()}
                    data-testid="share-grant-btn"
                    className="inline-flex h-6 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:border-zinc-300 disabled:cursor-default disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900 dark:hover:border-zinc-700 cursor-pointer"
                  >
                    Add
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
                aria-label="Restrict inherited access"
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
              {hasPublicAccess ? <Globe2 size={16} /> : <Lock size={16} />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Public access</p>
            </div>
          </div>
          <div
            ref={!canGrant && !isLoading ? accessHelpRefs.setReference : undefined}
            {...(!canGrant && !isLoading ? accessHelpInteractions.getReferenceProps() : {})}
            data-testid="share-public-access-permissions"
          >
            {isLimitedSummary ? (
              <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                Only admins can view public access settings and sharing details.
              </p>
            ) : (
              <ChoiceGroup
                value={summary?.publicAccess.permission ?? 'private'}
                options={permissionOptions}
                disabled={isLoading || !canGrant || updatePublicMutation.isPending}
                onChange={(permission) =>
                  updatePublicMutation.mutate({
                    entityType,
                    entityId,
                    permission,
                  })
                }
                className="w-full justify-between"
                ariaLabel="Public access"
              />
            )}
            {summary?.publicAccess.permission === 'edit' && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                No sign-in is required. Anyone with this URL can make normal editor changes.
              </p>
            )}
            {accessHelpOpen && !canGrant && !isLoading && (
              <FloatingPortal>
                <div
                  ref={accessHelpRefs.setFloating}
                  style={accessHelpFloatingStyles}
                  {...accessHelpInteractions.getFloatingProps()}
                  className="z-[9999] max-w-[280px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-zinc-600 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"
                >
                  You can see public access, but you need admin access to change it.
                </div>
              </FloatingPortal>
            )}
          </div>
          {publicUrl && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-zinc-500 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden dark:text-zinc-400">
                  {publicUrl}
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  data-testid="share-copy-url-btn"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 cursor-pointer"
                  title="Copy URL"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          )}
          {inheritedPublicAccess.length > 0 && (
            <div
              data-testid="inherited-public-access"
              className="rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/40 dark:bg-blue-950/20"
            >
              <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
                Inherited public access
              </p>
              <div className="mt-2 space-y-1.5">
                {inheritedPublicAccess.map((access) => (
                  <div
                    key={access.entityId}
                    className="flex items-center justify-between gap-3 text-[11px] text-blue-700 dark:text-blue-300"
                  >
                    <span className="truncate">via {access.entityTitle}</span>
                    <span className="shrink-0 font-medium">
                      Anyone can {access.permission === 'edit' ? 'edit' : 'view'}
                    </span>
                  </div>
                ))}
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
            {isLoading ? (
              <p className="px-3 py-2.5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                Loading access…
              </p>
            ) : isLimitedSummary ? (
              <p className="px-3 py-2.5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                {summary?.collaboratorCount ?? 0} other{' '}
                {(summary?.collaboratorCount ?? 0) === 1 ? 'person has' : 'people have'} access.
                Details are visible to admins only.
              </p>
            ) : accessEntries.length === 0 ? (
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
                  canGrant &&
                  entry.isManageable &&
                  !isTargetOwner &&
                  !(summary?.userPermission === 'admin' && isTargetAdmin);
                const canSelfRemove = Boolean(
                  isCurrentUser &&
                    !isTargetOwner &&
                    entry.isManageable &&
                    entry.kind === 'direct' &&
                    entry.grantId,
                );

                return (
                  <div
                    key={entry.key}
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
                    ) : entry.grantId && canChangePermission ? (
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
                            if (canSelfRemove && entry.grantId) {
                              if (window.confirm('Are you sure you want to leave?')) {
                                handleRemove(entry.grantId);
                              }
                            } else if (entry.grantId) {
                              handleRemove(entry.grantId);
                            }
                          } else if (entry.grantId) {
                            updateGrantPermissionMutation.mutate({
                              grantId: entry.grantId,
                              permission,
                            });
                          }
                        }}
                        className="w-fit"
                        triggerClassName="px-1.5 text-xs"
                      />
                    ) : canSelfRemove && entry.grantId ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm('Are you sure you want to leave?')) return;
                          if (entityType === 'page') markSelfLeave(entityId);
                          removeGrantMutation.mutate(entry.grantId as string, {
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
                      {!entry.isOwner && (
                        <span
                          className={
                            entry.isWinning ? 'text-emerald-600 dark:text-emerald-400' : undefined
                          }
                        >
                          {entry.isWinning ? ' · Effective' : ' · Fallback'}
                        </span>
                      )}
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
            aria-labelledby="share-dialog-title"
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
                    Grant account access or enable public access for this {entityType}.
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
