import type { FolderTreeNode } from '@markdawn/shared';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Folder, Home } from 'lucide-react';
import React, { useState } from 'react';

interface MoveDialogProps {
  isOpen: boolean;
  folders: FolderTreeNode[];
  onClose: () => void;
  onConfirm: (folderId: string | null) => void;
}

export function MoveDialog({ isOpen, folders, onClose, onConfirm }: MoveDialogProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (!isOpen) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderFolder = (folder: FolderTreeNode, depth = 0) => {
    const isExpanded = expandedIds.has(folder.id);
    const hasChildren = folder.children.length > 0;

    return (
      <div key={folder.id}>
        <div
          className={clsx(
            'w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
            selectedFolderId === folder.id
              ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
          )}
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleExpand(folder.id);
                }
              }}
              className="flex items-center justify-center w-5 h-5 rounded hover:bg-black/10 dark:hover:bg-white/10 shrink-0 cursor-pointer"
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <button
            type="button"
            className="flex-1 flex items-center gap-2 text-left cursor-pointer text-inherit"
            onClick={() => setSelectedFolderId(folder.id)}
          >
            <Folder size={16} />
            <span className="text-sm truncate">{folder.name}</span>
          </button>
        </div>
        {isExpanded && folder.children.map((child) => renderFolder(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-xl animate-slide-up flex flex-col max-h-[70vh]">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Move to</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Select a destination folder</p>

        <div className="mt-4 flex-1 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-lg p-2 space-y-1">
          <button
            type="button"
            className={clsx(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors',
              selectedFolderId === null
                ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
            )}
            onClick={() => setSelectedFolderId(null)}
          >
            <Home size={16} />
            <span className="text-sm font-medium">Workspace root</span>
          </button>
          {folders.map((folder) => renderFolder(folder))}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selectedFolderId)}
            className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}
