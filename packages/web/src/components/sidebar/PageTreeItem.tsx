import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  ChevronRight, 
  ChevronDown, 
  FileText, 
  MoreHorizontal, 
  Plus, 
  Trash2, 
  Edit2,
  Download
} from 'lucide-react';
import clsx from 'clsx';
import { PageTreeNode } from '@markdawn/shared';
import { useCreatePage, useUpdatePage, useDeletePage } from '../../hooks/use-pages';
import { ConfirmDialog } from '../ConfirmDialog';

interface PageTreeItemProps {
  page: PageTreeNode;
  depth?: number;
  expandedKeys: Set<string>;
  onToggleExpand: (pageId: string) => void;
  workspaceSlug: string;
}

export function PageTreeItem({ 
  page, 
  depth = 0, 
  expandedKeys, 
  onToggleExpand,
  workspaceSlug
}: PageTreeItemProps) {
  const navigate = useNavigate();
  const params = useParams();
  const activePageId = params.pageId;
  const isActive = activePageId === page.id;
  const isExpanded = expandedKeys.has(page.id);
  const hasChildren = Boolean(page.children && page.children.length > 0);
  
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(page.title);
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createPageMutation = useCreatePage();
  const updatePageMutation = useUpdatePage();
  const deletePageMutation = useDeletePage();

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNavigate = () => {
    navigate(`/app/${workspaceSlug}/${page.id}`);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(page.id);
  };

  const handleCreateChild = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!page.workspaceId) return;
    
    if (!isExpanded) {
      onToggleExpand(page.id);
    }
    
    try {
      const newPage = await createPageMutation.mutateAsync({ 
        workspaceId: page.workspaceId, 
        parentId: page.id 
      });
      navigate(`/app/${workspaceSlug}/${newPage.id}`);
    } catch (error) {
      console.error('Failed to create page', error);
    }
  };

  const handleRenameStart = () => {
    setIsEditing(true);
    setEditTitle(page.title);
    setShowMenu(false);
  };

  const handleRenameSave = async () => {
    if (editTitle.trim() && editTitle !== page.title) {
      try {
        await updatePageMutation.mutateAsync({ 
          pageId: page.id, 
          updates: { title: editTitle } 
        });
      } catch (error) {
        console.error('Failed to rename page', error);
        setEditTitle(page.title);
      }
    } else {
      setEditTitle(page.title);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSave();
    } else if (e.key === 'Escape') {
      setEditTitle(page.title);
      setIsEditing(false);
    }
  };

  const handleDelete = () => {
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    try {
      await deletePageMutation.mutateAsync(page.id);
      setShowDeleteDialog(false);
      if (isActive) {
        navigate(`/app/${workspaceSlug}`);
      }
    } catch (error) {
      console.error('Failed to delete page', error);
    }
  };

  const handleCancelDelete = () => {
    setShowDeleteDialog(false);
  };

  const handleExport = async () => {
    setShowMenu(false);
    try {
      const res = await fetch(`/api/pages/${page.id}/export/markdown`);
      if (!res.ok) {
        throw new Error("Failed to export markdown");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition");
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? `${page.title || "page"}.md`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to export page", error);
    }
  };

  return (
    <>
      <div className="select-none">
        <div 
          className={clsx(
            "group flex items-center h-8 pr-2 py-1 cursor-pointer transition-colors relative",
            isActive ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium" : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
          )}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
          onClick={handleNavigate}
          onDoubleClick={handleRenameStart}
          data-testid="page-tree-item"
        >
          <button
            type="button"
            onClick={hasChildren ? handleToggle : undefined}
            className={clsx(
              "flex items-center justify-center w-5 h-5 rounded-sm mr-2",
              hasChildren
                ? "hover:bg-zinc-300/50 dark:hover:bg-zinc-600/50 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer"
                : "text-zinc-400 dark:text-zinc-500",
            )}
            aria-label={hasChildren ? "Toggle nested pages" : "Page"}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            ) : (
              <FileText size={14} className={clsx(isActive ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500")} />
            )}
          </button>

          <div
            className={clsx(
              "flex-1 flex items-center min-w-0 transition-[padding] duration-150",
              showMenu ? "pr-14" : "pr-2 group-hover:pr-14",
            )}
          >
            
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleRenameSave}
                onKeyDown={handleKeyDown}
                className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-400 dark:border-zinc-500 rounded px-1 py-0.5 text-xs focus:outline-none h-6 min-w-0 text-zinc-900 dark:text-zinc-100"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
                <span className="truncate text-sm leading-none pt-0.5">{page.title}</span>
              )}
          </div>

          {!isEditing && (
            <div
              className={clsx(
                "absolute right-1 z-20 flex items-center gap-0.5 transition-opacity",
                showMenu
                  ? "opacity-100 pointer-events-auto"
                  : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
              )}
            >
              <button 
                onClick={handleCreateChild}
                className="p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                title="Add subpage"
              >
                <Plus size={14} />
              </button>
              
                <div className="relative" ref={menuRef}>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(!showMenu);
                  }}
                  className="p-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                >
                  <MoreHorizontal size={14} />
                </button>

                {showMenu && (
                  <div className="absolute right-0 top-6 w-32 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg rounded-md z-50 py-1 flex flex-col">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRenameStart();
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 w-full text-left cursor-pointer"
                    >
                      <Edit2 size={12} /> Rename
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExport();
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 w-full text-left cursor-pointer"
                    >
                      <Download size={12} /> Export
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete();
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 w-full text-left cursor-pointer"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {isExpanded && page.children && page.children.length > 0 && (
          <div>
            {page.children.map((child) => (
              <PageTreeItem
                key={child.id}
                page={child}
                depth={depth + 1}
                expandedKeys={expandedKeys}
                onToggleExpand={onToggleExpand}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete page"
        message={`Are you sure you want to delete "${page.title}"? This action cannot be undone.`}
        confirmText="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
        loading={deletePageMutation.isPending}
      />
    </>
  );
}
