import clsx from 'clsx';
import {
  Check,
  Copy,
  Download,
  Edit2,
  FileText,
  Folder,
  FolderInput,
  MoreHorizontal,
  Scissors,
  Trash2,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '../ConfirmDialog';

export type ExplorerItemType = 'page' | 'folder';

export interface ExplorerItemData {
  id: string;
  type: ExplorerItemType;
  title: string;
  icon?: string | null;
  updatedAt: string | Date;
  coverType?: string | null;
  coverValue?: string | null;
}

interface ExplorerItemProps {
  item: ExplorerItemData;
  viewMode: 'card' | 'list';
  isSelected: boolean;
  workspaceSlug: string;
  onSelect: (e: React.MouseEvent) => void;
  onNavigate: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onRename: () => void;
  onCopy: () => void;
  onCut: () => void;
  onMove: () => void;
  onExport?: () => void;
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditSave?: () => void;
  onEditKeyDown?: (e: React.KeyboardEvent) => void;
}

export function ExplorerItem({
  item,
  viewMode,
  isSelected,
  workspaceSlug,
  onSelect,
  onNavigate,
  onDelete,
  onRename,
  onCopy,
  onCut,
  onMove,
  onExport,
  isEditing = false,
  editValue = '',
  onEditChange,
  onEditSave,
  onEditKeyDown,
}: ExplorerItemProps) {
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!showMenu || !buttonRef.current) {
      setMenuStyle({});
      return;
    }

    const rect = buttonRef.current.getBoundingClientRect();
    const estimatedHeight = 220;
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 16;
    const openUpward = spaceBelow < estimatedHeight && spaceAbove >= estimatedHeight;
    const top = openUpward
      ? `${Math.max(8, rect.top - estimatedHeight)}px`
      : `${rect.bottom + 4}px`;

    setMenuStyle({
      position: 'fixed',
      right: `${window.innerWidth - rect.right}px`,
      top,
      zIndex: 9999,
      transformOrigin: openUpward ? 'bottom right' : 'top right',
    });
  }, [showMenu]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.item-action')) return;
    if (isEditing) return;
    onNavigate(e);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(e);
  };

  const updatedDate =
    typeof item.updatedAt === 'string' ? item.updatedAt : item.updatedAt.toISOString();

  if (viewMode === 'list') {
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          className={clsx(
            'group flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer transition-all duration-150',
            isSelected
              ? 'bg-zinc-100 dark:bg-zinc-800'
              : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
          )}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (isEditing) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleClick(e as unknown as React.MouseEvent);
            }
          }}
        >
          <button
            type="button"
            className={clsx(
              'item-action flex items-center justify-center w-5 h-5 rounded border transition-colors cursor-pointer',
              isSelected
                ? 'bg-zinc-900 dark:bg-zinc-100 border-zinc-900 dark:border-zinc-100 text-white dark:text-zinc-900'
                : 'border-zinc-300 dark:border-zinc-600 hover:border-zinc-500 dark:hover:border-zinc-400',
            )}
            onClick={handleCheckboxClick}
          >
            {isSelected && <Check size={12} strokeWidth={3} />}
          </button>

          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
            {item.type === 'folder' ? (
              <Folder size={18} />
            ) : item.icon ? (
              <span className="text-lg leading-none">{item.icon}</span>
            ) : (
              <FileText size={18} />
            )}
          </div>

          <div className="flex-1 min-w-0">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => onEditChange?.(e.target.value)}
                onBlur={onEditSave}
                onKeyDown={onEditKeyDown}
                className="w-full max-w-xs bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-zinc-900 dark:text-zinc-100"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate block">
                {item.title || 'Untitled'}
              </span>
            )}
          </div>

          <span className="text-xs text-zinc-400 dark:text-zinc-500 hidden md:block w-32 text-right shrink-0">
            {new Date(updatedDate).toLocaleDateString()}
          </span>

          <div className="relative shrink-0">
            <button
              ref={buttonRef}
              type="button"
              className="item-action p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
            >
              <MoreHorizontal size={16} />
            </button>

            {showMenu &&
              createPortal(
                <div
                  ref={menuRef}
                  style={menuStyle}
                  className="w-40 bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/5 shadow-xl rounded-xl p-1.5 flex flex-col animate-scale-in"
                >
                  {item.type === 'page' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        navigate(`/app/${workspaceSlug}/${item.id}`);
                      }}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <FileText size={14} /> Open
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onRename();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Edit2 size={14} /> Rename
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onCopy();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Copy size={14} /> Copy
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onCut();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Scissors size={14} /> Cut
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onMove();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <FolderInput size={14} /> Move
                  </button>
                  {onExport && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        onExport();
                      }}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <Download size={14} /> Export
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setShowDeleteDialog(true);
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>,
                document.body,
              )}
          </div>
        </div>

        <ConfirmDialog
          isOpen={showDeleteDialog}
          title="Move to trash"
          message={`Are you sure you want to move "${item.title || 'Untitled'}" to the trash?`}
          confirmText="Move to trash"
          onConfirm={() => {
            onDelete();
            setShowDeleteDialog(false);
          }}
          onCancel={() => setShowDeleteDialog(false)}
        />
      </>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={clsx(
          'group relative block p-5 bg-white dark:bg-zinc-900 border rounded-xl cursor-pointer transition-all duration-200',
          showMenu && 'z-10',
          isSelected
            ? 'border-zinc-900 dark:border-zinc-100 ring-2 ring-zinc-900 dark:ring-zinc-100'
            : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-md hover:scale-[1.02]',
        )}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (isEditing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick(e as unknown as React.MouseEvent);
          }
        }}
      >
        <div className="absolute top-3 left-3 z-10">
          <button
            type="button"
            className={clsx(
              'item-action flex items-center justify-center w-5 h-5 rounded border transition-colors cursor-pointer',
              isSelected
                ? 'bg-zinc-900 dark:bg-zinc-100 border-zinc-900 dark:border-zinc-100 text-white dark:text-zinc-900'
                : 'bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm border-zinc-300 dark:border-zinc-600 opacity-0 group-hover:opacity-100 hover:border-zinc-500 dark:hover:border-zinc-400',
            )}
            onClick={handleCheckboxClick}
          >
            {isSelected && <Check size={12} strokeWidth={3} />}
          </button>
        </div>

        <div
          className="h-28 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg mb-3 flex items-center justify-center text-zinc-300 dark:text-zinc-600 overflow-hidden"
          style={{
            background:
              item.type === 'page' && item.coverType === 'gradient'
                ? (item.coverValue ?? undefined)
                : undefined,
            backgroundColor:
              item.type === 'page' && item.coverType === 'solid'
                ? (item.coverValue ?? undefined)
                : undefined,
          }}
        >
          {item.type === 'folder' ? (
            <Folder size={40} className="text-zinc-400 dark:text-zinc-500" />
          ) : item.icon ? (
            <span className="text-4xl drop-shadow-sm">{item.icon}</span>
          ) : (
            <FileText size={40} className="text-zinc-300 dark:text-zinc-600" />
          )}
        </div>

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => onEditChange?.(e.target.value)}
                onBlur={onEditSave}
                onKeyDown={onEditKeyDown}
                className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-zinc-900 dark:text-zinc-100"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 text-sm truncate">
                {item.title || 'Untitled'}
              </h3>
            )}
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {item.type === 'folder'
                ? 'Folder'
                : `Edited ${new Date(updatedDate).toLocaleDateString()}`}
            </p>
          </div>

          <div className="relative shrink-0">
            <button
              ref={buttonRef}
              type="button"
              className="item-action p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
            >
              <MoreHorizontal size={16} />
            </button>

            {showMenu &&
              createPortal(
                <div
                  ref={menuRef}
                  style={menuStyle}
                  className="w-40 bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/5 shadow-xl rounded-xl p-1.5 flex flex-col animate-scale-in"
                >
                  {item.type === 'page' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        navigate(`/app/${workspaceSlug}/${item.id}`);
                      }}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <FileText size={14} /> Open
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onRename();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Edit2 size={14} /> Rename
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onCopy();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Copy size={14} /> Copy
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onCut();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Scissors size={14} /> Cut
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      onMove();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <FolderInput size={14} /> Move
                  </button>
                  {onExport && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        onExport();
                      }}
                      className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                    >
                      <Download size={14} /> Export
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setShowDeleteDialog(true);
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>,
                document.body,
              )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Move to trash"
        message={`Are you sure you want to move "${item.title || 'Untitled'}" to the trash?`}
        confirmText="Move to trash"
        onConfirm={() => {
          onDelete();
          setShowDeleteDialog(false);
        }}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </>
  );
}
