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
      <div className="flex items-center justify-center p-4 text-zinc-400">
        <Loader2 className="animate-spin" size={16} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to load pages
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="flex items-center justify-between px-2 mb-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider group">
          <span>Pages</span>
          <button 
            onClick={handleCreateRootPage}
            className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-zinc-200 rounded transition-opacity"
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
            <div className="px-2 py-4 text-center">
              <p className="text-sm text-zinc-400 mb-2">No pages yet</p>
              <button
                onClick={handleCreateRootPage}
                className="text-xs px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 rounded-md transition-colors font-medium"
              >
                Create your first page
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
