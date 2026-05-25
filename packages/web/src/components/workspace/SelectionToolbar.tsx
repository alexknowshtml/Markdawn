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
}: SelectionToolbarProps) {
  if (selectedCount === 0 && clipboardCount === 0) return null;

  const allSelected = selectedCount === totalCount && totalCount > 0;
  const hasSelection = selectedCount > 0;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 px-4 py-2.5 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 animate-slide-up">
      {totalCount > 0 && (
        <button
          type="button"
          onClick={allSelected ? onClear : onSelectAll}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-sm cursor-pointer"
          title={allSelected ? 'Deselect all' : 'Select all'}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
          <span className="hidden sm:inline">{allSelected ? 'Deselect all' : 'Select all'}</span>
        </button>
      )}
      <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
      <span className="text-sm font-medium px-2">{selectedCount} selected</span>
      <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
      <button
        type="button"
        onClick={onCopy}
        disabled={!hasSelection}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Copy"
      >
        <Copy size={14} />
        <span className="hidden sm:inline">Copy</span>
      </button>
      <button
        type="button"
        onClick={onCut}
        disabled={!hasSelection}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Cut"
      >
        <Scissors size={14} />
        <span className="hidden sm:inline">Cut</span>
      </button>
      <button
        type="button"
        onClick={onMove}
        disabled={!hasSelection}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Move"
      >
        <FolderInput size={14} />
        <span className="hidden sm:inline">Move</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!hasSelection}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
        title="Delete"
      >
        <Trash2 size={14} />
        <span className="hidden sm:inline">Delete</span>
      </button>
      <button
        type="button"
        onClick={onPaste}
        disabled={clipboardCount === 0}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-sm cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title={`Paste ${clipboardCount} item${clipboardCount !== 1 ? 's' : ''}`}
      >
        <ClipboardPaste size={14} />
        <span className="hidden sm:inline">Paste {clipboardCount > 0 ? clipboardCount : ''}</span>
      </button>
      <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
      <button
        type="button"
        onClick={onClear}
        className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        title="Deselect all"
      >
        <X size={16} />
      </button>
    </div>
  );
}
