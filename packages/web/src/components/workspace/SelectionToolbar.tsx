import {
  CheckSquare,
  ClipboardPaste,
  Copy,
  FolderInput,
  Scissors,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../ConfirmDialog';

interface SelectionToolbarProps {
  selectedCount: number;
  totalCount: number;
  clipboardCount: number;
  onDelete: () => void;
  onCopy: () => void;
  onCut: () => void;
  onMove: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  canDelete?: boolean;
  canMove?: boolean;
  canPaste?: boolean;
  isRemoving?: boolean;
}

export function SelectionToolbar({
  selectedCount,
  totalCount,
  clipboardCount,
  onDelete,
  onCopy,
  onCut,
  onMove,
  onPaste,
  onSelectAll,
  onClear,
  canDelete = true,
  canMove = true,
  canPaste = true,
  isRemoving = false,
}: SelectionToolbarProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  if (selectedCount === 0 && clipboardCount === 0) return null;

  const allSelected = selectedCount === totalCount && totalCount > 0;
  const hasSelection = selectedCount > 0;

  return (
    <>
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 px-4 py-2.5 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 animate-slide-up">
        {totalCount > 0 && (
          <button
            type="button"
            onClick={allSelected ? onClear : onSelectAll}
            disabled={isRemoving}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-sm cursor-pointer disabled:opacity-50 disabled:cursor-wait"
            title={allSelected ? 'Deselect all' : 'Select all'}
          >
            {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            <span className="hidden sm:inline">{allSelected ? 'Deselect all' : 'Select all'}</span>
          </button>
        )}
        <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
        <span className="text-sm font-medium px-2">
          {isRemoving
            ? `Removing ${selectedCount} item${selectedCount === 1 ? '' : 's'}…`
            : `${selectedCount} selected`}
        </span>
        <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
        <button
          type="button"
          onClick={onCopy}
          disabled={!hasSelection || isRemoving}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Copy"
        >
          <Copy size={14} />
          <span className="hidden sm:inline">Copy</span>
        </button>
        <button
          type="button"
          onClick={onCut}
          disabled={!hasSelection || !canMove || isRemoving}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title={canMove ? 'Cut' : 'Admin access is required to move selected items'}
        >
          <Scissors size={14} />
          <span className="hidden sm:inline">Cut</span>
        </button>
        <button
          type="button"
          onClick={onMove}
          disabled={!hasSelection || !canMove || isRemoving}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title={canMove ? 'Move' : 'Admin access is required to move selected items'}
        >
          <FolderInput size={14} />
          <span className="hidden sm:inline">Move</span>
        </button>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          disabled={!hasSelection || !canDelete || isRemoving}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
          title={
            isRemoving
              ? 'Removing selected items'
              : canDelete
                ? 'Delete or leave'
                : 'Selected inherited items cannot be removed here'
          }
        >
          <Trash2 size={14} />
          <span className="hidden sm:inline">Delete</span>
        </button>
        <button
          type="button"
          onClick={onPaste}
          disabled={clipboardCount === 0 || !canPaste || isRemoving}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title={
            canPaste
              ? `Paste ${clipboardCount} item${clipboardCount !== 1 ? 's' : ''}`
              : 'Admin access is required to paste here'
          }
        >
          <ClipboardPaste size={14} />
          <span className="hidden sm:inline">Paste {clipboardCount > 0 ? clipboardCount : ''}</span>
        </button>
        <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
        <button
          type="button"
          onClick={onClear}
          disabled={isRemoving}
          className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          title="Deselect all"
        >
          <X size={16} />
        </button>
      </div>
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="Delete selected items"
        message={`Remove ${selectedCount} selected item${selectedCount === 1 ? '' : 's'}? Owned folders and their contents will be moved to trash. Shared items will be removed from your view.`}
        confirmText="Remove items"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          onDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  );
}
