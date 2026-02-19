import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  ChevronRight, 
  ChevronDown, 
  FileText, 
  MoreHorizontal, 
  Plus, 
  Trash2, 
  Edit2 
} from 'lucide-react';
import clsx from 'clsx';
import { PageTreeNode } from '@markdawn/shared';
import { useCreatePage, useUpdatePage, useDeletePage } from '../../hooks/use-pages';

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
  
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(page.title);
  const [showMenu, setShowMenu] = useState(false);
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

  const handleDelete = async () => {
    if (window.confirm(`Are you sure you want to delete "${page.title}"?`)) {
      try {
        await deletePageMutation.mutateAsync(page.id);
        if (isActive) {
          navigate(`/app/${workspaceSlug}`);
        }
      } catch (error) {
        console.error('Failed to delete page', error);
      }
    }
  };

  return (
    <div className="select-none">
      <div 
        className={clsx(
          "group flex items-center h-8 pr-2 py-1 cursor-pointer transition-colors relative",
          isActive ? "bg-zinc-200 text-zinc-900 font-medium" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        )}
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        onClick={handleNavigate}
        onDoubleClick={handleRenameStart}
        data-testid="page-tree-item"
      >
        <div 
          className="flex items-center justify-center w-5 h-5 rounded-sm hover:bg-zinc-300/50 mr-1 text-zinc-400 hover:text-zinc-600"
          onClick={handleToggle}
        >
          {page.children && page.children.length > 0 ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <div className="w-4" /> 
          )}
        </div>

        <div className="flex-1 flex items-center min-w-0 mr-2">
          <FileText size={14} className={clsx("mr-2 flex-shrink-0", isActive ? "text-zinc-900" : "text-zinc-400")} />
          
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleRenameSave}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-white border border-blue-500 rounded px-1 py-0.5 text-xs focus:outline-none h-6 min-w-0"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate text-sm leading-none pt-0.5">{page.title}</span>
          )}
        </div>

        {!isEditing && (
          <div className="hidden group-hover:flex items-center gap-0.5 absolute right-2 bg-gradient-to-l from-inherit pl-2">
            <button 
              onClick={handleCreateChild}
              className="p-1 rounded hover:bg-zinc-300 text-zinc-500 hover:text-zinc-900"
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
                className="p-1 rounded hover:bg-zinc-300 text-zinc-500 hover:text-zinc-900"
              >
                <MoreHorizontal size={14} />
              </button>

              {showMenu && (
                <div className="absolute right-0 top-6 w-32 bg-white border border-zinc-200 shadow-lg rounded-md z-50 py-1 flex flex-col">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameStart();
                    }}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 w-full text-left"
                  >
                    <Edit2 size={12} /> Rename
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete();
                    }}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 w-full text-left"
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
  );
}
