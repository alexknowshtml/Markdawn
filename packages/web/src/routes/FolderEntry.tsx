import type { FolderTreeNode, PageTreeNode } from '@markdawn/shared';
import {
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  Home as HomeIcon,
  LayoutGrid,
  List,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExplorerItem, type ExplorerItemData } from '../components/workspace/ExplorerItem';
import { MoveDialog } from '../components/workspace/MoveDialog';
import { SelectionToolbar } from '../components/workspace/SelectionToolbar';
import { useClipboard } from '../contexts/ClipboardContext';
import { useSelection } from '../contexts/SelectionContext';
import {
  type PublicFolderPage,
  type PublicFolderPayload,
  useShareContext,
} from '../contexts/ShareContext';
import {
  useBulkDeleteFolders,
  useBulkDeletePages,
  useBulkLeaveFolders,
  useBulkLeavePages,
  useBulkMoveFolders,
  useBulkMovePages,
} from '../hooks/use-bulk-actions';
import { useCopyFolder, useCopyPage } from '../hooks/use-copy';
import { useFavorites } from '../hooks/use-favorites';
import { useCreateFolder, useFolderTree, useUpdateFolder } from '../hooks/use-folders';
import { useFolderCollaborators, usePageCollaborators } from '../hooks/use-page-collaborators';
import { useCreatePage, usePageTree, useUpdatePage } from '../hooks/use-pages';
import { useAuth } from '../hooks/useAuth';
import { getPagesInFolder } from '../utils/page-tree';
import { showSuccessToast } from '../utils/toast';
import { buildFolderPath, buildPagePath, extractUuidFromSlug } from '../utils/url';

const toDate = (value: string | Date | null | undefined): Date => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
};

const normalizePublicPage = (page: PublicFolderPage, folderId: string): PageTreeNode => ({
  id: page.id,
  parentId: page.parentId ?? page.parent_id ?? folderId,
  title: page.title,
  icon: page.icon ?? null,
  coverType: null,
  coverValue: null,
  position: '0',
  ydoc: null,
  properties: null,
  createdBy: page.createdBy ?? page.created_by ?? null,
  ownerId: page.ownerId ?? page.owner_id ?? null,
  createdAt: toDate(page.createdAt ?? page.created_at),
  updatedAt: toDate(page.updatedAt ?? page.updated_at),
  children: [],
});

const normalizePublicFolder = (
  folder: PublicFolderPayload,
  fallbackParentId: string | null,
): FolderTreeNode => ({
  id: folder.id,
  parentId: folder.parentId ?? fallbackParentId,
  name: folder.name,
  icon: folder.icon ?? null,
  position: folder.position ?? '0',
  createdBy: folder.createdBy ?? null,
  createdAt: toDate(folder.createdAt),
  updatedAt: toDate(folder.updatedAt),
  publicToken: null,
  ownerId: folder.ownerId ?? folder.owner_id ?? null,
  ...(folder.isPublic !== undefined ? { isPublic: folder.isPublic } : {}),
  children: (folder.folders ?? []).map((child) => normalizePublicFolder(child, folder.id)),
});

const findFolderById = (
  nodes: FolderTreeNode[] | undefined,
  folderId: string | undefined,
): FolderTreeNode | null => {
  if (!nodes || !folderId) return null;
  for (const node of nodes) {
    if (node.id === folderId) return node;
    const found = findFolderById(node.children, folderId);
    if (found) return found;
  }
  return null;
};

export default function FolderEntry() {
  const navigate = useNavigate();
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const folderId = slugAndId ? extractUuidFromSlug(slugAndId) : undefined;

  const {
    data: pages,
    isLoading: isPagesLoading,
    error: pagesError,
    refetch: refetchPages,
  } = usePageTree();
  const { data: folders, isLoading: isFoldersLoading, error: foldersError } = useFolderTree();
  const { data: favorites } = useFavorites();
  const { data: session } = useAuth();
  const { capabilities, isAnonymous, publicEntity } = useShareContext();
  const currentUserId = session?.user?.id;
  const canWrite = !!currentUserId && capabilities.canEdit;

  const favoriteKeys = useMemo(
    () => new Set(favorites?.map((fav) => `${fav.entityType}:${fav.entityId}`) ?? []),
    [favorites],
  );
  const isFavoriteItem = (item: ExplorerItemData) => favoriteKeys.has(`${item.type}:${item.id}`);

  const createPageMutation = useCreatePage();
  const createFolderMutation = useCreateFolder();
  const updatePageMutation = useUpdatePage();
  const updateFolderMutation = useUpdateFolder();
  const copyPageMutation = useCopyPage();
  const copyFolderMutation = useCopyFolder();
  const bulkDeletePagesMutation = useBulkDeletePages();
  const bulkDeleteFoldersMutation = useBulkDeleteFolders();
  const bulkLeavePagesMutation = useBulkLeavePages();
  const bulkLeaveFoldersMutation = useBulkLeaveFolders();
  const bulkMovePagesMutation = useBulkMovePages();
  const bulkMoveFoldersMutation = useBulkMoveFolders();

  const clipboard = useClipboard();
  const selection = useSelection();

  const filterOutSelf = useMemo(
    () =>
      <T extends { userId?: string }>(collaborators: T[]): T[] =>
        currentUserId ? collaborators.filter((c) => c.userId !== currentUserId) : collaborators,
    [currentUserId],
  );

  const [viewMode, setViewMode] = useState<'card' | 'list'>(() => {
    const saved = localStorage.getItem('markdawn:viewMode');
    return saved === 'list' ? 'list' : 'card';
  });
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<{
    kind: 'page' | 'folder';
    id: string;
    value: string;
  } | null>(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selection.clear();
    setLastSelectedIndex(null);
  }, [selection.clear]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(event.target as Node)) {
        setShowNewMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const treeFolder = useMemo(() => findFolderById(folders, folderId), [folders, folderId]);
  const shouldUsePublicPayload =
    !!folderId && publicEntity?.id === folderId && (isAnonymous || !treeFolder);

  const publicFolder = useMemo(
    () =>
      shouldUsePublicPayload && publicEntity
        ? normalizePublicFolder(publicEntity, publicEntity.parentId ?? null)
        : null,
    [publicEntity, shouldUsePublicPayload],
  );

  const breadcrumbPath = useMemo(() => {
    if (!folderId) return [];
    if (publicFolder) return [publicFolder];
    const path: FolderTreeNode[] = [];
    const find = (nodes: FolderTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === folderId) {
          path.push(node);
          return true;
        }
        if (node.children.length > 0) {
          if (find(node.children)) {
            path.unshift(node);
            return true;
          }
        }
      }
      return false;
    };
    find(folders ?? []);
    return path;
  }, [folders, folderId, publicFolder]);

  const currentFolders = useMemo(() => {
    if (publicFolder) return publicFolder.children;
    if (!folderId) return folders ?? [];
    const find = (nodes: FolderTreeNode[]): FolderTreeNode[] => {
      for (const node of nodes) {
        if (node.id === folderId) return node.children;
        const found = find(node.children);
        if (found.length > 0) return found;
      }
      return [];
    };
    return find(folders ?? []);
  }, [folders, folderId, publicFolder]);

  const currentPages = useMemo(() => {
    if (shouldUsePublicPayload && publicEntity?.pages && folderId) {
      return publicEntity.pages.map((page) => normalizePublicPage(page, folderId));
    }
    return getPagesInFolder(pages ?? [], folderId ?? null);
  }, [pages, folderId, publicEntity, shouldUsePublicPayload]);

  const pageIds = useMemo(
    () => (isAnonymous ? [] : currentPages.map((p) => p.id)),
    [currentPages, isAnonymous],
  );
  const { data: collaboratorsMap } = usePageCollaborators(pageIds);

  const childFolderIds = useMemo(
    () => (isAnonymous ? [] : currentFolders.map((f) => f.id)),
    [currentFolders, isAnonymous],
  );
  const { data: folderCollaboratorsMap } = useFolderCollaborators(childFolderIds);

  const allItems: ExplorerItemData[] = useMemo(() => {
    const folderItems: ExplorerItemData[] = currentFolders.map((f) => ({
      id: f.id,
      type: 'folder',
      title: f.name,
      icon: f.icon,
      updatedAt: f.updatedAt,
      ownerId: f.ownerId,
      createdBy: f.createdBy,
      ...(folderCollaboratorsMap?.[f.id] ? { collaborators: folderCollaboratorsMap[f.id] } : {}),
    }));
    const pageItems: ExplorerItemData[] = currentPages.map((p) => ({
      id: p.id,
      type: 'page',
      title: p.title,
      icon: p.icon,
      updatedAt: p.updatedAt,
      coverType: p.coverType,
      coverValue: p.coverValue,
      ownerId: p.ownerId,
      createdBy: p.createdBy,
      ...(collaboratorsMap?.[p.id] ? { collaborators: collaboratorsMap[p.id] } : {}),
    }));
    return [...folderItems, ...pageItems];
  }, [currentFolders, currentPages, collaboratorsMap, folderCollaboratorsMap]);

  const favoriteItems = useMemo(
    () => allItems.filter((item) => favoriteKeys.has(`${item.type}:${item.id}`)),
    [allItems, favoriteKeys],
  );

  const allItemIndexMap = useMemo(
    () => new Map(allItems.map((item, index) => [item.id, index])),
    [allItems],
  );

  const hasSelection = selection.selectedCount > 0;

  const handleCreatePage = async () => {
    try {
      const newPage = await createPageMutation.mutateAsync({
        ...(folderId ? { parentId: folderId } : {}),
      });
      navigate(buildPagePath(newPage.title, newPage.id));
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handleCreateFolder = async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({
        ...(folderId ? { parentId: folderId } : {}),
      });
      setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handleItemClick = (
    item: ExplorerItemData,
    index: number,
    e: React.MouseEvent | React.KeyboardEvent,
  ) => {
    if (e.ctrlKey || e.metaKey) {
      selection.toggle({ id: item.id, type: item.type });
      setLastSelectedIndex(index);
    } else if (e.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const range = allItems.slice(start, end + 1).map((i) => ({ id: i.id, type: i.type }));
      selection.selectAll(range);
    } else {
      if (item.type === 'folder') {
        navigate(buildFolderPath(item.title, item.id));
      } else {
        navigate(buildPagePath(item.title, item.id));
      }
    }
  };

  const handleRenameItem = (item: ExplorerItemData) => {
    setEditingTarget({ kind: item.type, id: item.id, value: item.title });
  };

  const handleSaveRename = () => {
    if (!editingTarget) return;
    const trimmed = editingTarget.value.trim();
    const onSettled = () => setEditingTarget(null);
    if (editingTarget.kind === 'folder') {
      updateFolderMutation.mutate(
        {
          folderId: editingTarget.id,
          updates: { name: trimmed.length > 0 ? trimmed : 'New Folder' },
        },
        { onSettled },
      );
    } else {
      updatePageMutation.mutate(
        { pageId: editingTarget.id, updates: { title: trimmed.length > 0 ? trimmed : 'Untitled' } },
        { onSettled },
      );
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveRename();
    } else if (e.key === 'Escape') {
      setEditingTarget(null);
    }
  };

  const selectedItems = useMemo(
    () =>
      selection.selectedItems.map((selected) => {
        const item = allItems.find(
          (candidate) => candidate.id === selected.id && candidate.type === selected.type,
        );
        return { ...selected, ownerId: item?.ownerId ?? null };
      }),
    [selection.selectedItems, allItems],
  );

  const handleBulkDelete = async () => {
    const ownedPageIds = selectedItems
      .filter((item) => item.type === 'page' && item.ownerId === currentUserId)
      .map((item) => item.id);
    const sharedPageIds = selectedItems
      .filter((item) => item.type === 'page' && item.ownerId !== currentUserId)
      .map((item) => item.id);
    const ownedFolderIds = selectedItems
      .filter((item) => item.type === 'folder' && item.ownerId === currentUserId)
      .map((item) => item.id);
    const sharedFolderIds = selectedItems
      .filter((item) => item.type === 'folder' && item.ownerId !== currentUserId)
      .map((item) => item.id);

    try {
      if (ownedPageIds.length > 0)
        await bulkDeletePagesMutation.mutateAsync({ pageIds: ownedPageIds });
      if (ownedFolderIds.length > 0)
        await bulkDeleteFoldersMutation.mutateAsync({ folderIds: ownedFolderIds });
      if (sharedPageIds.length > 0)
        await bulkLeavePagesMutation.mutateAsync({ entityIds: sharedPageIds });
      if (sharedFolderIds.length > 0)
        await bulkLeaveFoldersMutation.mutateAsync({ entityIds: sharedFolderIds });
      selection.clear();
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handleBulkCopy = () => {
    clipboard.copy(selection.selectedItems);
    showSuccessToast('Copied to clipboard');
  };

  const handleBulkCut = () => {
    clipboard.cut(selection.selectedItems);
    showSuccessToast('Cut to clipboard');
  };

  const handleBulkMove = () => {
    setMoveDialogOpen(true);
  };

  const handleConfirmMove = async (targetFolderId: string | null) => {
    const pageIds = selection.selectedItems.filter((i) => i.type === 'page').map((i) => i.id);
    const folderIds = selection.selectedItems.filter((i) => i.type === 'folder').map((i) => i.id);

    try {
      if (pageIds.length > 0)
        await bulkMovePagesMutation.mutateAsync({
          pageIds,
          parentId: targetFolderId,
        });
      if (folderIds.length > 0)
        await bulkMoveFoldersMutation.mutateAsync({
          folderIds,
          parentId: targetFolderId,
        });
      selection.clear();
      setMoveDialogOpen(false);
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handlePaste = async () => {
    if (!clipboard.state.action || clipboard.state.items.length === 0) return;
    const currentParentId = folderId ?? null;

    try {
      if (clipboard.state.action === 'copy') {
        for (const item of clipboard.state.items) {
          if (item.type === 'page') {
            await copyPageMutation.mutateAsync({
              pageId: item.id,
              parentId: currentParentId,
            });
          } else {
            await copyFolderMutation.mutateAsync({
              folderId: item.id,
              parentId: currentParentId,
            });
          }
        }
        showSuccessToast('Pasted');
      } else if (clipboard.state.action === 'cut') {
        const pageIds = clipboard.state.items.filter((i) => i.type === 'page').map((i) => i.id);
        const folderIds = clipboard.state.items.filter((i) => i.type === 'folder').map((i) => i.id);
        if (pageIds.length > 0)
          await bulkMovePagesMutation.mutateAsync({
            pageIds,
            parentId: currentParentId,
          });
        if (folderIds.length > 0)
          await bulkMoveFoldersMutation.mutateAsync({
            folderIds,
            parentId: currentParentId,
          });
        clipboard.clear();
        showSuccessToast('Moved');
      }
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const isLoading = !shouldUsePublicPayload && (isPagesLoading || isFoldersLoading);
  const hasError = !shouldUsePublicPayload && (pagesError || foldersError);

  if (!folderId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FileText size={48} className="text-zinc-300 dark:text-zinc-600 mb-4" />
        <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-50 mb-2">Invalid folder</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm">
          This folder URL is not valid.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 min-w-0">
          <Link
            to="/app"
            className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            <HomeIcon size={14} />
            <span className="font-medium">Home</span>
          </Link>
          {breadcrumbPath.map((folder) => (
            <React.Fragment key={folder.id}>
              <ChevronRight size={14} className="mx-1 shrink-0" />
              <Link
                to={buildFolderPath(folder.name, folder.id)}
                className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors truncate"
              >
                {folder.name}
              </Link>
            </React.Fragment>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => {
                setViewMode('card');
                localStorage.setItem('markdawn:viewMode', 'card');
              }}
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${viewMode === 'card' ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'}`}
              title="Card view"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('list');
                localStorage.setItem('markdawn:viewMode', 'list');
              }}
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${viewMode === 'list' ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'}`}
              title="List view"
            >
              <List size={16} />
            </button>
          </div>
          {canWrite && (
            <div className="relative flex items-stretch" ref={newMenuRef}>
              <button
                type="button"
                onClick={handleCreatePage}
                className="flex items-center gap-1.5 pl-3 pr-2 h-7 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-l-lg text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer border border-zinc-200 dark:border-zinc-700 border-r-0"
              >
                <FilePlus2 size={14} />
                <span className="hidden sm:inline">New Page</span>
              </button>
              <button
                type="button"
                onClick={() => setShowNewMenu((prev) => !prev)}
                className="flex items-center px-1.5 h-7 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-r-lg text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer border border-zinc-200 dark:border-zinc-700"
              >
                <ChevronRight size={14} className="rotate-90" />
              </button>
              {showNewMenu && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 p-1.5 flex flex-col animate-scale-in origin-top-right">
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewMenu(false);
                      void handleCreatePage();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <FilePlus2 size={14} /> New Page
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewMenu(false);
                      void handleCreateFolder();
                    }}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors"
                  >
                    <FolderPlus size={14} /> New Folder
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {hasError ? (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-md flex items-center justify-between">
          <span>Failed to load items.</span>
          <button
            type="button"
            onClick={() => refetchPages()}
            className="px-3 py-1 bg-red-100 dark:bg-red-900/40 hover:bg-red-200 dark:hover:bg-red-900/60 rounded text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <div
          className={`${viewMode === 'card' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-1'} animate-fade-in`}
        >
          {[1, 2, 3, 4, 5, 6].map((id) => (
            <div
              key={id}
              className="block p-5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl"
            >
              <div className="h-28 bg-zinc-100 dark:bg-zinc-800 rounded-lg mb-3 animate-pulse" />
              <div className="h-5 bg-zinc-100 dark:bg-zinc-800 rounded w-3/4 mb-2 animate-pulse" />
              <div className="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-1/2 animate-pulse" />
            </div>
          ))}
        </div>
      ) : allItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FileText size={48} className="text-zinc-300 dark:text-zinc-600 mb-4" />
          <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-50 mb-2">No items yet</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm">
            {canWrite ? 'Create a new page or folder to get started.' : 'No items in this folder.'}
          </p>
        </div>
      ) : viewMode === 'card' ? (
        <div className="space-y-8 animate-fade-in">
          {favoriteItems.length > 0 && (
            <div>
              <h2 className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3 px-1">
                Favorites
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {favoriteItems.map((item) => (
                  <ExplorerItem
                    key={`${item.type}-${item.id}`}
                    item={item}
                    viewMode="card"
                    isSelected={selection.isSelected(item.id)}
                    isFavorite={isFavoriteItem(item)}
                    onSelect={(e) => {
                      e.stopPropagation();
                      selection.toggle({ id: item.id, type: item.type });
                    }}
                    onNavigate={(e) => handleItemClick(item, allItemIndexMap.get(item.id) ?? 0, e)}
                    onRename={() => handleRenameItem(item)}
                    collaborators={filterOutSelf(item.collaborators ?? [])}
                    canSelect={canWrite}
                    showContextMenu={!isAnonymous}
                  />
                ))}
              </div>
            </div>
          )}
          <div>
            <h2 className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3 px-1">
              All Pages
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allItems.map((item, index) => (
                <ExplorerItem
                  key={`${item.type}-${item.id}`}
                  item={item}
                  viewMode="card"
                  isSelected={selection.isSelected(item.id)}
                  isFavorite={isFavoriteItem(item)}
                  onSelect={(e) => {
                    e.stopPropagation();
                    selection.toggle({ id: item.id, type: item.type });
                  }}
                  onNavigate={(e) => handleItemClick(item, index, e)}
                  onRename={() => handleRenameItem(item)}
                  isEditing={editingTarget?.kind === item.type && editingTarget.id === item.id}
                  editValue={editingTarget?.value ?? ''}
                  onEditChange={(value) =>
                    setEditingTarget((prev) => (prev ? { ...prev, value } : null))
                  }
                  onEditSave={handleSaveRename}
                  onEditKeyDown={handleEditKeyDown}
                  collaborators={filterOutSelf(item.collaborators ?? [])}
                  canSelect={canWrite}
                  showContextMenu={!isAnonymous}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {favoriteItems.length > 0 && (
            <div>
              <h2 className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3 px-1">
                Favorites
              </h2>
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-clip">
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2 text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider border-b border-zinc-200 dark:border-zinc-800">
                  <span className="w-8" />
                  <span className="-ml-10">Name</span>
                  <span className="hidden md:block w-28">Shared with</span>
                  <span className="hidden md:block w-36">Last edited</span>
                  <span className="w-8" />
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {favoriteItems.map((item) => (
                    <ExplorerItem
                      key={`${item.type}-${item.id}`}
                      item={item}
                      viewMode="list"
                      isSelected={selection.isSelected(item.id)}
                      isFavorite={isFavoriteItem(item)}
                      onSelect={(e) => {
                        e.stopPropagation();
                        selection.toggle({ id: item.id, type: item.type });
                      }}
                      onNavigate={(e) =>
                        handleItemClick(item, allItemIndexMap.get(item.id) ?? 0, e)
                      }
                      onRename={() => handleRenameItem(item)}
                      collaborators={filterOutSelf(item.collaborators ?? [])}
                      canSelect={canWrite}
                      showContextMenu={!isAnonymous}
                      showCheckboxes={hasSelection}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div>
            <h2 className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3 px-1">
              All Pages
            </h2>
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-clip">
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2 text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider border-b border-zinc-200 dark:border-zinc-800">
                <span className="w-8" />
                <span className="-ml-10">Name</span>
                <span className="hidden md:block w-28">Shared with</span>
                <span className="hidden md:block w-36">Last edited</span>
                <span className="w-8" />
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {allItems.map((item, index) => (
                  <ExplorerItem
                    key={`${item.type}-${item.id}`}
                    item={item}
                    viewMode="list"
                    isSelected={selection.isSelected(item.id)}
                    isFavorite={isFavoriteItem(item)}
                    onSelect={(e) => {
                      e.stopPropagation();
                      selection.toggle({ id: item.id, type: item.type });
                    }}
                    onNavigate={(e) => handleItemClick(item, index, e)}
                    onRename={() => handleRenameItem(item)}
                    isEditing={editingTarget?.kind === item.type && editingTarget.id === item.id}
                    editValue={editingTarget?.value ?? ''}
                    onEditChange={(value) =>
                      setEditingTarget((prev) => (prev ? { ...prev, value } : null))
                    }
                    onEditSave={handleSaveRename}
                    onEditKeyDown={handleEditKeyDown}
                    collaborators={filterOutSelf(item.collaborators ?? [])}
                    canSelect={canWrite}
                    showContextMenu={!isAnonymous}
                    showCheckboxes={hasSelection}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {canWrite && (
        <SelectionToolbar
          selectedCount={selection.selectedCount}
          totalCount={allItems.length}
          clipboardCount={clipboard.state.items.length}
          onDelete={handleBulkDelete}
          onCopy={handleBulkCopy}
          onCut={handleBulkCut}
          onMove={handleBulkMove}
          onPaste={() => void handlePaste()}
          onSelectAll={() => selection.selectAll(allItems.map((i) => ({ id: i.id, type: i.type })))}
          onClear={() => {
            selection.clear();
            clipboard.clear();
          }}
        />
      )}

      <MoveDialog
        isOpen={moveDialogOpen}
        folders={folders ?? []}
        movingFolderIds={selection.selectedItems
          .filter((item) => item.type === 'folder')
          .map((item) => item.id)}
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleConfirmMove}
      />
    </div>
  );
}
