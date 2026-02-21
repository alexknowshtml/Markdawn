import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2 } from 'lucide-react';
import { PageTreeNode } from '@markdawn/shared';
import { usePageTree, useCreatePage } from '../../hooks/use-pages';
import { PageTreeItem } from './PageTreeItem';

interface PageTreeProps {
  workspaceId: string;
  workspaceSlug: string;
}

export function PageTree({ workspaceId, workspaceSlug }: PageTreeProps) {
  const navigate = useNavigate();
  const { data: pages, isLoading, error } = usePageTree(workspaceId);
  const createPageMutation = useCreatePage();
  
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`markdawn-expanded-pages-${workspaceId}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    const handleStorage = () => {
      try {
        localStorage.setItem(
          `markdawn-expanded-pages-${workspaceId}`, 
          JSON.stringify(Array.from(expandedKeys))
        );
      } catch (e) {
        console.error('Failed to save expanded state', e);
      }
    };
    handleStorage();
  }, [expandedKeys, workspaceId]);

  const handleToggleExpand = (pageId: string) => {
    const newExpanded = new Set(expandedKeys);
    if (newExpanded.has(pageId)) {
      newExpanded.delete(pageId);
    } else {
      newExpanded.add(pageId);
    }
    setExpandedKeys(newExpanded);
  };

  const handleCreateRootPage = async () => {
    try {
      const newPage = await createPageMutation.mutateAsync({ workspaceId });
      navigate(`/app/${workspaceSlug}/${newPage.id}`);
    } catch (error) {
      console.error('Failed to create root page', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-center mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400 dark:text-zinc-500" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="h-4 w-3/4 bg-zinc-200 dark:bg-zinc-800 rounded animate-shimmer"></div>
          <div className="h-4 w-1/2 bg-zinc-200 dark:bg-zinc-800 rounded animate-shimmer"></div>
          <div className="h-4 w-5/6 bg-zinc-200 dark:bg-zinc-800 rounded animate-shimmer"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 p-3 text-sm text-red-500 bg-zinc-100 dark:bg-zinc-800/50 rounded-md border border-red-200 dark:border-red-900/30">
        Failed to load pages
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="flex items-center justify-between px-2 mb-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider group">
          <span>Pages</span>
          <button 
            onClick={handleCreateRootPage}
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition-all text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
            title="New Page"
            data-testid="new-page-btn"
          >
            <Plus size={14} />
          </button>
        </div>
        
        <div className="space-y-0.5">
          {pages?.map((page: PageTreeNode) => (
            <PageTreeItem
              key={page.id}
              page={page}
              expandedKeys={expandedKeys}
              onToggleExpand={handleToggleExpand}
              workspaceSlug={workspaceSlug}
            />
          ))}
          
          {pages?.length === 0 && (
            <div className="px-4 py-8 text-center flex flex-col items-center justify-center animate-fade-in">
              <p className="text-sm text-zinc-400 dark:text-zinc-500 mb-3">No pages yet</p>
              <button
                onClick={handleCreateRootPage}
                className="text-xs px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 rounded-md transition-colors font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Plus size={12} />
                <span>Create your first page</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
