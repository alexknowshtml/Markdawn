import { Copy, Download, Edit2, FolderInput, Share, Star, Trash2 } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useClipboard } from '../../contexts/ClipboardContext';
import { useBulkMoveFolders, useBulkMovePages } from '../../hooks/use-bulk-actions';
import { useToggleFavorite } from '../../hooks/use-favorites';
import { useFolderTree } from '../../hooks/use-folders';
import { useAuth } from '../../hooks/useAuth';
import { useEntityDeletion } from '../../utils/entity-actions';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
// showErrorToast kept for non-mutation use in handleExport
import { PublicShareDialog } from '../editor/PublicShareDialog';
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
  };
  isFavorite?: boolean;
  triggerClassName?: string;
  menuClassName?: string;
  onOpenChange?: ((isOpen: boolean) => void) | undefined;
  onRename?: () => void;
  onDelete?: () => void;
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
  onMutated,
}: PageContextMenuProps) {
  const clipboard = useClipboard();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;
  const toggleFavoriteMutation = useToggleFavorite();
  const bulkMovePagesMutation = useBulkMovePages();
  const bulkMoveFoldersMutation = useBulkMoveFolders();
  const { data: folders } = useFolderTree();
  const { handleDelete } = useEntityDeletion({
    entityType: item.type,
    currentUserId,
    onSuccess: onMutated,
  });

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);

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
    if (onDelete) {
      onDelete();
      return;
    }
    performDelete();
  };

  const performDelete = async () => {
    try {
      await handleDelete(
        { id: item.id, type: item.type, ownerId: item.ownerId, createdBy: item.createdBy },
        { force: item.type === 'folder' },
      );
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const menuItems = [
    {
      label: isFavorite ? 'Unfavorite' : 'Favorite',
      icon: <Star size={14} className={isFavorite ? 'text-yellow-500 fill-yellow-500' : ''} />,
      onClick: handleToggleFavorite,
    },
    onRename && {
      label: 'Rename',
      icon: <Edit2 size={14} />,
      onClick: onRename,
    },
    {
      label: 'Share',
      icon: <Share size={14} />,
      onClick: () => setShowShareDialog(true),
    },
    {
      label: 'Export',
      icon: <Download size={14} />,
      onClick: handleExport,
    },
    {
      label: 'Delete',
      icon: <Trash2 size={14} className="text-red-600 dark:text-red-400" />,
      className: '!text-red-600 dark:!text-red-400 hover:!bg-red-500/10',
      onClick: handleDeleteClick,
    },
    {
      label: 'Move',
      icon: <FolderInput size={14} />,
      onClick: handleMove,
    },
    {
      label: 'Copy',
      icon: <Copy size={14} />,
      onClick: handleCopy,
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
        <PublicShareDialog
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
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleConfirmMove}
      />
    </>
  );
}
