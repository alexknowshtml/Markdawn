import { Copy, Download, Edit2, FolderInput, Share, Star, Trash2 } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useClipboard } from '../../contexts/ClipboardContext';
import { useBulkMoveFolders, useBulkMovePages } from '../../hooks/use-bulk-actions';
import { useToggleFavorite } from '../../hooks/use-favorites';
import { useDeleteFolder, useFolderTree } from '../../hooks/use-folders';
import { useDeletePage } from '../../hooks/use-pages';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { ConfirmDialog } from '../ConfirmDialog';
import { PublicShareDialog } from '../editor/PublicShareDialog';
import { MoveDialog } from '../workspace/MoveDialog';
import { KebabMenu } from './KebabMenu';

type PageContextMenuProps = {
  item: {
    id: string;
    type: 'page' | 'folder';
    title: string;
    icon?: string | null;
  };
  isFavorite?: boolean;
  confirmDelete?: boolean;
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
  confirmDelete = false,
  triggerClassName,
  menuClassName,
  onOpenChange,
  onRename,
  onDelete,
  onMutated,
}: PageContextMenuProps) {
  const clipboard = useClipboard();
  const deletePageMutation = useDeletePage();
  const deleteFolderMutation = useDeleteFolder();
  const toggleFavoriteMutation = useToggleFavorite();
  const bulkMovePagesMutation = useBulkMovePages();
  const bulkMoveFoldersMutation = useBulkMoveFolders();
  const { data: folders } = useFolderTree();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);

  const handleCopy = () => {
    clipboard.copy([{ id: item.id, type: item.type }]);
    showSuccessToast('Copied to clipboard');
  };

  const handleMove = () => {
    setMoveDialogOpen(true);
  };

  const handleConfirmMove = async (targetFolderId: string | null) => {
    try {
      if (item.type === 'page') {
        await bulkMovePagesMutation.mutateAsync({
          pageIds: [item.id],
          parentId: targetFolderId,
        });
      } else {
        await bulkMoveFoldersMutation.mutateAsync({
          folderIds: [item.id],
          parentId: targetFolderId,
        });
      }
      setMoveDialogOpen(false);
      onMutated?.();
    } catch {
      showErrorToast('Failed to move item');
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

  const handleToggleFavorite = async () => {
    await toggleFavoriteMutation.mutateAsync({
      pageId: item.id,
      isFavorite: !isFavorite,
    });
    onMutated?.();
  };

  const handleDeleteClick = () => {
    if (onDelete) {
      onDelete();
      return;
    }
    if (confirmDelete) {
      setShowDeleteDialog(true);
      return;
    }
    performDelete();
  };

  const performDelete = async () => {
    try {
      if (item.type === 'page') {
        await deletePageMutation.mutateAsync(item.id);
      } else {
        await deleteFolderMutation.mutateAsync({ folderId: item.id, force: true });
      }
      onMutated?.();
    } catch {
      showErrorToast('Failed to delete');
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
      icon: <Trash2 size={14} />,
      className: 'text-red-600 dark:text-red-400 hover:bg-red-500/10',
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
      {confirmDelete && (
        <ConfirmDialog
          isOpen={showDeleteDialog}
          title="Move to trash"
          message={`Are you sure you want to move "${item.title || 'Untitled'}" to the trash?`}
          confirmText="Move to trash"
          onConfirm={() => {
            void performDelete();
            setShowDeleteDialog(false);
          }}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
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
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleConfirmMove}
      />
    </>
  );
}
