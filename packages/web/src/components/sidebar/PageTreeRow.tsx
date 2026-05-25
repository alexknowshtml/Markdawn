import clsx from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Edit2,
  FileText,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '../ConfirmDialog';

interface PageTreeRowProps {
  id: string;
  title: string;
  icon?: string | null;
  workspaceSlug: string;
  isActive?: boolean;
  depth?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  isFavorite?: boolean;
  showDragHandle?: boolean;
  onToggleExpand?: () => void;
  onToggleFavorite?: () => void;
  onCreateChild?: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  onExport?: () => void;
  onNavigate?: () => void;
  isEditing?: boolean;
  editTitle?: string;
  onEditChange?: (value: string) => void;
  onEditSave?: () => void;
  onEditKeyDown?: (e: React.KeyboardEvent) => void;
  isDragTarget?: boolean;
  isFolder?: boolean;
}

export function PageTreeRow({
  id,
  title,
  icon,
  workspaceSlug,
  isActive = false,
  depth = 0,
  hasChildren = false,
  isExpanded = false,
  isFavorite = false,
  showDragHandle = false,
  onToggleExpand,
  onToggleFavorite,
  onCreateChild,
  onDelete,
  onRename,
  onExport,
  onNavigate,
  isEditing = false,
  editTitle = '',
  onEditChange,
  onEditSave,
  onEditKeyDown,
  isDragTarget = false,
  isFolder = false,
}: PageTreeRowProps) {
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleNavigate = () => {
    if (onNavigate) {
      onNavigate();
    } else {
      navigate(`/app/${workspaceSlug}/${id}`);
    }
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleExpand) onToggleExpand();
  };

  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleFavorite) onToggleFavorite();
  };

  const handleCreateChild = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCreateChild) onCreateChild();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    if (onDelete) {
      await onDelete();
      setShowDeleteDialog(false);
    }
  };

  const handleExportClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    if (onExport) onExport();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    if (onRename) onRename();
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={clsx(
          'group flex items-center h-8 pr-2 py-1 my-0.5 rounded-lg cursor-pointer transition-all duration-200 ease-in-out relative',
          isActive
            ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)]'
            : 'text-zinc-600 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-zinc-900 dark:hover:text-zinc-100',
          isDragTarget && 'opacity-60',
        )}
        style={{ paddingLeft: `${depth * 12 + 12}px`, marginLeft: '8px', marginRight: '8px' }}
        onClick={handleNavigate}
        onKeyDown={(e) => {
          if (isEditing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleNavigate();
          }
        }}
        data-testid="page-tree-row"
      >
        <button
          type="button"
          onClick={hasChildren ? handleToggleExpand : undefined}
          className={clsx(
            'flex items-center justify-center w-5 h-5 rounded-md mr-2 transition-colors',
            showDragHandle ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
            hasChildren
              ? 'hover:bg-black/10 dark:hover:bg-white/10 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
              : 'text-zinc-400 dark:text-zinc-500 opacity-50',
          )}
          aria-label={hasChildren ? 'Toggle nested pages' : 'Page'}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : isFolder ? (
            <span className="text-sm leading-none">📁</span>
          ) : icon ? (
            <span className="text-sm leading-none">{icon}</span>
          ) : (
            <FileText
              size={14}
              className={clsx(
                isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500',
              )}
            />
          )}
        </button>

        <div
          className={clsx(
            'flex-1 flex items-center min-w-0 transition-[padding] duration-150',
            showMenu ? 'pr-14' : 'pr-2 group-hover:pr-14',
          )}
        >
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editTitle}
              onChange={(e) => onEditChange?.(e.target.value)}
              onBlur={onEditSave}
              onKeyDown={onEditKeyDown}
              className="flex-1 bg-white/50 dark:bg-black/20 border border-black/10 dark:border-white/10 rounded-md px-1 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 h-6 min-w-0 text-zinc-900 dark:text-zinc-100"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate text-sm leading-none pt-0.5">{title}</span>
          )}
        </div>

        {!isEditing && (
          <div
            className={clsx(
              'absolute right-1 z-20 flex items-center gap-0.5 transition-opacity',
              showMenu
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
            )}
          >
            {onToggleFavorite && (
              <button
                type="button"
                onClick={handleToggleFavorite}
                className={clsx(
                  'p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer transition-colors',
                  isFavorite
                    ? 'text-yellow-500 hover:text-yellow-600'
                    : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100',
                )}
                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
              </button>
            )}

            {onCreateChild && (
              <button
                type="button"
                onClick={handleCreateChild}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer transition-colors"
                title="Add page"
              >
                <Plus size={14} />
              </button>
            )}

            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(!showMenu);
                }}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer transition-colors"
              >
                <MoreHorizontal size={14} />
              </button>

              {showMenu && (
                <div className="absolute right-0 top-7 w-36 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl border border-black/5 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] rounded-2xl z-50 p-1.5 flex flex-col animate-scale-in origin-top-right">
                  {onRename && (
                    <button
                      type="button"
                      onClick={handleRenameClick}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <Edit2 size={14} /> Rename
                    </button>
                  )}
                  {onExport && (
                    <button
                      type="button"
                      onClick={handleExportClick}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <Download size={14} /> Export
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={handleDeleteClick}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {onDelete && (
        <ConfirmDialog
          isOpen={showDeleteDialog}
          title="Move to trash"
          message={`Are you sure you want to move "${title}" to the trash?`}
          confirmText="Move to trash"
          onConfirm={handleConfirmDelete}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </>
  );
}
