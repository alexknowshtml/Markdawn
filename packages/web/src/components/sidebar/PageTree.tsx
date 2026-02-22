import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Loader2, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { PageTreeNode } from '@markdawn/shared';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, DragStartEvent, DragOverEvent, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { usePageTree, useCreatePage, useMovePage } from '../../hooks/use-pages';
import { useFavorites } from '../../hooks/use-favorites';
import { useRecentPages } from '../../hooks/use-recent';
import { PageTreeItem } from './PageTreeItem';
import clsx from 'clsx';
import { generatePosition } from '@markdawn/shared';
import { showErrorToast } from "../../utils/toast"

interface PageTreeProps {
  workspaceId: string;
  workspaceSlug: string;
}

export function PageTree({ workspaceId, workspaceSlug }: PageTreeProps) {
  const navigate = useNavigate();
  const params = useParams();
  const activePageId = params.pageId;
  const { data: pages, isLoading, error } = usePageTree(workspaceId);
  const { data: favorites } = useFavorites(workspaceId);
  const { data: recentPages } = useRecentPages(workspaceId);
  const createPageMutation = useCreatePage();
  const movePageMutation = useMovePage();
  
  const [isRecentExpanded, setIsRecentExpanded] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside' | null>(null);
  
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
        showErrorToast('Failed to save expanded state');
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
      showErrorToast('Failed to create root page');
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const flatPages = useMemo(() => {
    const items: PageTreeNode[] = [];
    const walk = (nodes: PageTreeNode[]) => {
      nodes.forEach((node) => {
        items.push(node);
        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      });
    };
    if (pages) {
      walk(pages);
    }
    return items;
  }, [pages]);

  const pageById = useMemo(() => {
    const map = new Map<string, PageTreeNode>();
    flatPages.forEach((page) => {
      map.set(page.id, page);
    });
    return map;
  }, [flatPages]);

  const getSiblings = (parentId: string | null) => {
    if (!pages) return [] as PageTreeNode[];
    if (!parentId) return pages;
    const parent = pageById.get(parentId);
    return parent?.children ?? [];
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    const active = event.active.id ? String(event.active.id) : null;
    const over = event.over?.id ? String(event.over.id) : null;
    setActiveId(active);
    setOverId(over);
    if (!over || !active) {
      setDropPosition(null);
      return;
    }
    if (over === active) {
      setDropPosition(null);
      return;
    }

    const overRect = event.over?.rect;
    const dragRect = event.active.rect.current.translated;
    if (!overRect || !dragRect) {
      setDropPosition('after');
      return;
    }

    const pointerY = dragRect.top + dragRect.height / 2;
    const relativeY = (pointerY - overRect.top) / overRect.height;
    if (relativeY > 0.3 && relativeY < 0.7) {
      setDropPosition('inside');
    } else if (relativeY >= 0.7) {
      setDropPosition('after');
    } else {
      setDropPosition('before');
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const active = event.active.id ? String(event.active.id) : null;
    const over = event.over?.id ? String(event.over.id) : null;
    const positionHint = dropPosition;
    setActiveId(null);
    setOverId(null);
    setDropPosition(null);

    if (!active || !over || active === over) {
      return;
    }

    const activePage = pageById.get(active);
    const overPage = pageById.get(over);

    if (!activePage || !overPage) {
      return;
    }

    const nextParentId = positionHint === 'inside' ? overPage.id : overPage.parentId ?? null;
    const siblings = getSiblings(nextParentId);
    const filteredSiblings = siblings.filter((sibling) => sibling.id !== activePage.id);
    const overIndex = filteredSiblings.findIndex((sibling) => sibling.id === overPage.id);

    let insertIndex = filteredSiblings.length;
    if (positionHint === 'before') {
      insertIndex = Math.max(0, overIndex);
    } else if (positionHint === 'after') {
      insertIndex = overIndex + 1;
    } else if (positionHint === 'inside') {
      insertIndex = filteredSiblings.length;
    }

    const prev = insertIndex > 0 ? filteredSiblings[insertIndex - 1]?.position : null;
    const next = insertIndex < filteredSiblings.length ? filteredSiblings[insertIndex]?.position : null;
    const newPosition = generatePosition(prev, next);

    try {
      await movePageMutation.mutateAsync({
        pageId: activePage.id,
        parentId: nextParentId,
        position: newPosition
      });
    } catch {
      return;
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
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        
        {favorites && favorites.length > 0 && (
          <div>
            <div className="flex items-center px-2 mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              <span>Favorites</span>
            </div>
            <div className="space-y-0.5">
              {favorites.map((fav) => (
                <div
                  key={fav.pageId}
                  onClick={() => navigate(`/app/${workspaceSlug}/${fav.pageId}`)}
                  className={clsx(
                    "group flex items-center h-8 pl-3 pr-2 py-1 cursor-pointer transition-colors",
                    activePageId === fav.pageId
                      ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
                  )}
                >
                  <div className="flex items-center justify-center w-5 h-5 mr-2 text-zinc-400 dark:text-zinc-500">
                    {fav.icon ? (
                      <span className="text-sm leading-none">{fav.icon}</span>
                    ) : (
                      <FileText size={14} className={clsx(activePageId === fav.pageId ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500")} />
                    )}
                  </div>
                  <span className="truncate text-sm leading-none pt-0.5 flex-1">{fav.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {recentPages && recentPages.length > 0 && (
          <div>
            <div 
              className="flex items-center px-2 mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
              onClick={() => setIsRecentExpanded(!isRecentExpanded)}
            >
              <span className="flex items-center gap-1">
                {isRecentExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Recently Visited
              </span>
            </div>
            {isRecentExpanded && (
              <div className="space-y-0.5">
                {recentPages.map((recent) => (
                  <div
                    key={recent.id}
                    onClick={() => navigate(`/app/${workspaceSlug}/${recent.id}`)}
                    className={clsx(
                      "group flex items-center h-8 pl-3 pr-2 py-1 cursor-pointer transition-colors",
                      activePageId === recent.id
                        ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                        : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
                    )}
                  >
                    <div className="flex items-center justify-center w-5 h-5 mr-2 text-zinc-400 dark:text-zinc-500">
                      {recent.icon ? (
                        <span className="text-sm leading-none">{recent.icon}</span>
                      ) : (
                        <FileText size={14} className={clsx(activePageId === recent.id ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500")} />
                      )}
                    </div>
                    <span className="truncate text-sm leading-none pt-0.5 flex-1">{recent.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between px-2 mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider group">
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
          
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={pages?.map((page) => page.id) ?? []} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {pages?.map((page: PageTreeNode) => (
                  <PageTreeItem
                    key={page.id}
                    page={page}
                    expandedKeys={expandedKeys}
                    onToggleExpand={handleToggleExpand}
                    workspaceSlug={workspaceSlug}
                    activeId={activeId ?? null}
                    overId={overId ?? null}
                    dropPosition={dropPosition ?? null}
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
            </SortableContext>
            <DragOverlay>
              {activeId ? (
                <div className="rounded-md bg-white/90 dark:bg-zinc-900/90 shadow-lg border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100">
                  {pageById.get(activeId)?.title ?? 'Moving page'}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>
    </div>
  );
}
