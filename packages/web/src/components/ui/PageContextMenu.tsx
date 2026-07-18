import { Copy, Download, Edit2, FolderInput, Share, Star, Trash2 } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useClipboard } from '../../contexts/ClipboardContext';
import { useIdentityLifecycle } from '../../contexts/IdentityLifecycleContext';
import { useShareContext } from '../../contexts/ShareContext';
import { useBulkMoveFolders, useBulkMovePages } from '../../hooks/use-bulk-actions';
import { useToggleFavorite } from '../../hooks/use-favorites';
import { useFolderTree } from '../../hooks/use-folders';
import { useWorkspaceMemberships } from '../../hooks/use-workspace';
import { useAuth } from '../../hooks/useAuth';
import {
  canRenameEntity,
  isOwnedByUser,
  preservesEffectiveOwnerAtRoot,
  useEntityDeletion,
  useLeaveEntity,
} from '../../utils/entity-actions';
import { consumeSelfLeave, markSelfLeave } from '../../utils/leave-page';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
// showErrorToast kept for non-mutation use in handleExport
import { ConfirmDialog } from '../ConfirmDialog';
import { ShareDialog } from '../editor/ShareDialog';
import { MoveDialog } from '../workspace/MoveDialog';
import { KebabMenu } from './KebabMenu';

type PageContextMenuProps = {
  item: {
    id: string;
    type: 'page' | 'folder';
    title: string;
    icon?: string | null;
    ownerId?: string | null | undefined;
    createdBy?: string | null | undefined;
    userPermission?: 'view' | 'edit' | 'admin' | null | undefined;
    shareSource?: 'direct' | 'public' | 'workspace' | undefined;
    canMove?: boolean | undefined;
  };
  isFavorite?: boolean;
  triggerClassName?: string;
  menuClassName?: string;
  onOpenChange?: ((isOpen: boolean) => void) | undefined;
  onRename?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onMutated?: () => void;
};

export function PageContextMenu({
  item,
  isFavorite = false,
  triggerClassName,
  menuClassName,
  onOpenChange,
  onRename,
  onDelete,
  onCopy,
  onMutated,
}: PageContextMenuProps) {
  const identityLifecycle = useIdentityLifecycle();
  const clipboard = useClipboard();
  const { isAnonymous } = useShareContext();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const toggleFavoriteMutation = useToggleFavorite();
  const bulkMovePagesMutation = useBulkMovePages();
  const bulkMoveFoldersMutation = useBulkMoveFolders();
  const { data: folders } = useFolderTree({ enabled: !isAnonymous });
  const { data: workspaceMemberships } = useWorkspaceMemberships({ enabled: !isAnonymous });
  const { handleDelete, isPending: isDeletePending } = useEntityDeletion({
    entityType: item.type,
    currentUserId,
    onSuccess: onMutated,
  });
  const leaveMutation = useLeaveEntity(item.type);

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [folderDeleteSummary, setFolderDeleteSummary] = useState<{
    childFolders: number;
    childPages: number;
  } | null>(null);

  const isOwned = currentUserId ? isOwnedByUser(item, currentUserId) : false;
  const isAdmin = isOwned || item.userPermission === 'admin';
  const canRename = canRenameEntity(item, currentUserId);
  const canLeave =
    !isAnonymous && !isOwned && (item.shareSource === 'direct' || item.shareSource === 'public');
  const canMove = item.canMove ?? isAdmin;
  const hasWorkspaceRootAccess =
    isOwned ||
    workspaceMemberships?.some(
      (membership) => membership.ownerId === item.ownerId && membership.role === 'admin',
    ) === true;
  const allowMoveToRoot = hasWorkspaceRootAccess && preservesEffectiveOwnerAtRoot(item);

  const handleCopy = () => {
    clipboard.copy([{ id: item.id, type: item.type }]);
    showSuccessToast('Copied to clipboard');
  };

  const handleMove = () => {
    setMoveDialogOpen(true);
  };

  const handleConfirmMove = (targetFolderId: string | null) => {
    const onSuccess = () => {
      setMoveDialogOpen(false);
      onMutated?.();
    };
    if (item.type === 'page') {
      bulkMovePagesMutation.mutate({ pageIds: [item.id], parentId: targetFolderId }, { onSuccess });
    } else {
      bulkMoveFoldersMutation.mutate(
        { folderIds: [item.id], parentId: targetFolderId },
        { onSuccess },
      );
    }
  };

  const handleExport = async () => {
    try {
      const res = await fetch(`/api/pages/${item.id}/export/markdown`);
      if (!res.ok) throw new Error('Failed to export');
      const blob = await res.blob();
      if (!identityLifecycle.isActive()) return;
      const disposition = res.headers.get('content-disposition');
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? `${item.title || 'page'}.md`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccessToast('Exported to markdown');
    } catch {
      if (!identityLifecycle.isActive()) return;
      showErrorToast('Failed to export note');
    }
  };

  const handleToggleFavorite = () => {
    toggleFavoriteMutation.mutate(
      {
        entityType: item.type,
        entityId: item.id,
        title: item.title,
        icon: item.icon ?? null,
        ownerId: item.ownerId ?? null,
        isFavorite,
      },
      { onSuccess: () => onMutated?.() },
    );
  };

  const handleDeleteClick = () => {
    if (item.type === 'folder') {
      void requestFolderDelete();
      return;
    }
    if (onDelete) {
      onDelete();
      return;
    }
    void performDelete(false);
  };

  const handleLeaveClick = async () => {
    if (item.type === 'page') markSelfLeave(item.id);
    try {
      await leaveMutation.mutateAsync(item.id);
      if (!identityLifecycle.isActive()) return;
      onMutated?.();
    } catch {
      if (!identityLifecycle.isActive()) return;
      if (item.type === 'page') consumeSelfLeave(item.id);
      // Error toast handled globally by MutationCache.onError
    }
  };

  const performDelete = async (force: boolean) => {
    try {
      return await handleDelete(
        {
          id: item.id,
          type: item.type,
          ownerId: item.ownerId,
          createdBy: item.createdBy,
          userPermission: item.userPermission,
          shareSource: item.shareSource,
        },
        { force },
      );
    } catch {
      // Error toast handled globally by MutationCache.onError
      return undefined;
    }
  };

  const requestFolderDelete = async () => {
    const result = await performDelete(false);
    if (result && 'requiresForce' in result) {
      setFolderDeleteSummary({
        childFolders: result.childFolders,
        childPages: result.childPages,
      });
    }
  };

  const confirmFolderDelete = async () => {
    const result = await performDelete(true);
    if (result && 'deleted' in result) {
      setFolderDeleteSummary(null);
    }
  };

  const menuItems = [
    !isAnonymous && {
      label: isFavorite ? 'Unfavorite' : 'Favorite',
      icon: <Star size={14} className={isFavorite ? 'text-yellow-500 fill-yellow-500' : ''} />,
      onClick: handleToggleFavorite,
    },
    onRename &&
      canRename && {
        label: 'Rename',
        icon: <Edit2 size={14} />,
        onClick: onRename,
      },
    !isAnonymous && {
      label: 'Share',
      icon: <Share size={14} />,
      onClick: () => setShowShareDialog(true),
    },
    item.type === 'page' &&
      !isAnonymous && {
        label: 'Export',
        icon: <Download size={14} />,
        onClick: handleExport,
      },
    isAdmin && {
      label: 'Delete',
      icon: <Trash2 size={14} className="text-red-600 dark:text-red-400" />,
      className: '!text-red-600 dark:!text-red-400 hover:!bg-red-500/10',
      onClick: handleDeleteClick,
    },
    canLeave && {
      label: 'Leave',
      icon: <Trash2 size={14} className="text-red-600 dark:text-red-400" />,
      className: '!text-red-600 dark:!text-red-400 hover:!bg-red-500/10',
      onClick: () => void handleLeaveClick(),
    },
    canMove && {
      label: 'Move',
      icon: <FolderInput size={14} />,
      onClick: handleMove,
    },
    (!isAnonymous || onCopy) && {
      label: 'Copy',
      icon: <Copy size={14} />,
      onClick: onCopy ?? handleCopy,
    },
  ].filter(Boolean) as {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    className?: string;
  }[];

  return (
    <>
      <KebabMenu
        {...(triggerClassName != null ? { triggerClassName } : {})}
        {...(menuClassName != null ? { menuClassName } : {})}
        {...(onOpenChange != null ? { onOpenChange } : {})}
        items={menuItems}
      />
      {showShareDialog && (
        <ShareDialog
          entityType={item.type}
          entityId={item.id}
          title={item.title}
          onClose={() => setShowShareDialog(false)}
        />
      )}
      <MoveDialog
        isOpen={moveDialogOpen}
        folders={folders ?? []}
        movingFolderIds={item.type === 'folder' ? [item.id] : []}
        {...(item.ownerId !== undefined ? { movingOwnerId: item.ownerId } : {})}
        allowRoot={allowMoveToRoot}
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleConfirmMove}
      />
      <ConfirmDialog
        isOpen={folderDeleteSummary !== null}
        title="Delete folder and contents"
        message={
          folderDeleteSummary
            ? `This folder contains ${folderDeleteSummary.childFolders} nested folder${folderDeleteSummary.childFolders === 1 ? '' : 's'} and ${folderDeleteSummary.childPages} page${folderDeleteSummary.childPages === 1 ? '' : 's'}. Move all of them to trash?`
            : ''
        }
        confirmText="Move to trash"
        onConfirm={() => void confirmFolderDelete()}
        onCancel={() => setFolderDeleteSummary(null)}
        loading={isDeletePending}
      />
    </>
  );
}
