import type { CollaboratorDisplay, FolderTreeNode, SharedWithMeItem } from '@markdawn/shared';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  Home as HomeIcon,
  LayoutGrid,
  List,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExplorerItem, type ExplorerItemData } from '../components/workspace/ExplorerItem';
import { MoveDialog } from '../components/workspace/MoveDialog';
import { SelectionToolbar } from '../components/workspace/SelectionToolbar';
import { useClipboard } from '../contexts/ClipboardContext';
import { useIdentityLifecycle, useIdentityNavigate } from '../contexts/IdentityLifecycleContext';
import { useSelection } from '../contexts/SelectionContext';
import {
  buildBulkRemovalInput,
  canRetryBulkRemoval,
  formatBulkRemovalFailure,
  getBulkRemovalCounts,
  useBulkMoveFolders,
  useBulkMovePages,
  useBulkRemoveEntities,
} from '../hooks/use-bulk-actions';
import { useCopyFolder, useCopyPage } from '../hooks/use-copy';
import { useFavorites } from '../hooks/use-favorites';
import { useFolderTree, useUpdateFolder } from '../hooks/use-folders';
import { useFolderCollaborators, usePageCollaborators } from '../hooks/use-page-collaborators';
import { usePageTree, useUpdatePage } from '../hooks/use-pages';
import { useSharedWithMe } from '../hooks/use-shared-with-me';
import { useWorkspaceMemberships } from '../hooks/use-workspace';
import { useAuth } from '../hooks/useAuth';
import { useEntityCreationActions } from '../hooks/useEntityCreationActions';
import { useStableValueWhile } from '../hooks/useStableValue';
import { isBulkRemovalInProgress } from '../utils/bulkRemovalState';
import {
  canRenameEntity,
  preservesEffectiveOwnerAtRoot,
  resolveRemovalShareSource,
} from '../utils/entity-actions';
import { collectAllFolderIds, getRootPages } from '../utils/page-tree';
import { hasInitialQueryError } from '../utils/queryState';
import { showSuccessToast } from '../utils/toast';
import { buildFolderPath, buildPagePath } from '../utils/url';

type DashboardFilter = 'all' | 'owned-by-me' | 'shared-with-me';

type DashboardItem = ExplorerItemData & {
  activityAt?: string | Date;
};

const FILTERS: { value: DashboardFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'owned-by-me', label: 'Owned By Me' },
  { value: 'shared-with-me', label: 'Shared With Me' },
];

const normalizeFilter = (value: string | null): DashboardFilter => {
  if (value === 'owned-by-me' || value === 'shared-with-me') return value;
  return 'all';
};

const dateMs = (value: string | Date | null | undefined): number => {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
};

const sortByActivityDesc = (a: DashboardItem, b: DashboardItem): number => {
  const aTime = Math.max(dateMs(a.activityAt), dateMs(a.updatedAt));
  const bTime = Math.max(dateMs(b.activityAt), dateMs(b.updatedAt));
  return bTime - aTime;
};

const sharedItemToExplorerItem = (item: SharedWithMeItem): DashboardItem => ({
  id: item.entityId,
  type: item.entityType,
  title: item.title,
  icon: item.icon,
  ownerId: item.ownerId,
  userPermission: item.permission,
  shareSource: item.source,
  canMove: false,
  updatedAt: item.entityUpdatedAt ?? item.updatedAt ?? item.createdAt ?? item.sortAt ?? new Date(),
  activityAt: item.sortAt ?? item.updatedAt ?? item.createdAt ?? item.entityUpdatedAt ?? new Date(),
});

export default function HomeView() {
  const navigate = useIdentityNavigate();
  const identityLifecycle = useIdentityLifecycle();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeFilter = normalizeFilter(searchParams.get('filter'));

  const {
    data: pages,
    isLoading: isPagesLoading,
    error: pagesError,
    refetch: refetchPages,
  } = usePageTree();
  const {
    data: folders,
    isLoading: isFoldersLoading,
    error: foldersError,
    refetch: refetchFolders,
  } = useFolderTree();
  const {
    data: sharedWithMe,
    isLoading: isSharedLoading,
    error: sharedError,
    refetch: refetchSharedWithMe,
  } = useSharedWithMe();
  const {
    data: workspaceMemberships,
    error: workspaceMembershipsError,
    refetch: refetchWorkspaceMemberships,
  } = useWorkspaceMemberships();
  const { data: favorites, error: favoritesError, refetch: refetchFavorites } = useFavorites();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || isBulkRemovalInProgress()) return;
      void Promise.all([refetchPages(), refetchFolders(), refetchSharedWithMe()]);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [refetchPages, refetchFolders, refetchSharedWithMe]);

  const bulkRemoveMutation = useBulkRemoveEntities();
  const refreshedFavoriteKeys = useMemo(
    () => new Set(favorites?.map((fav) => `${fav.entityType}:${fav.entityId}`) ?? []),
    [favorites],
  );
  const favoriteKeys = useStableValueWhile(refreshedFavoriteKeys, bulkRemoveMutation.isPending);
  const isFavorite = (item: ExplorerItemData) => favoriteKeys.has(`${item.type}:${item.id}`);

  const entityCreation = useEntityCreationActions();
  const updatePageMutation = useUpdatePage();
  const updateFolderMutation = useUpdateFolder();
  const copyPageMutation = useCopyPage();
  const copyFolderMutation = useCopyFolder();
  const bulkMovePagesMutation = useBulkMovePages();
  const bulkMoveFoldersMutation = useBulkMoveFolders();

  const clipboard = useClipboard();
  const selection = useSelection();

  const filterOutSelf = useMemo(
    () =>
      (collaborators: CollaboratorDisplay[]): CollaboratorDisplay[] =>
        currentUserId
          ? collaborators.filter((collaborator) => collaborator.userId !== currentUserId)
          : collaborators,
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
  const [removalFailure, setRemovalFailure] = useState<{
    message: string;
    canRetry: boolean;
  } | null>(null);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void activeFilter;
    selection.clear();
    setLastSelectedIndex(null);
  }, [selection.clear, activeFilter]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (filterMenuRef.current && !filterMenuRef.current.contains(target)) {
        setShowFilterMenu(false);
      }
      if (newMenuRef.current && !newMenuRef.current.contains(target)) {
        setShowNewMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const breadcrumbPath = useMemo<FolderTreeNode[]>(() => [], []);

  const ownedFolders = useMemo(
    () => (folders ?? []).filter((folder) => folder.ownerId === currentUserId),
    [folders, currentUserId],
  );
  const ownedFolderIds = useMemo(() => new Set(collectAllFolderIds(ownedFolders)), [ownedFolders]);
  const ownedPages = useMemo(
    () => (pages ?? []).filter((page) => page.ownerId === currentUserId),
    [pages, currentUserId],
  );
  const ownedRootPages = useMemo(
    () => getRootPages(ownedPages, ownedFolderIds),
    [ownedPages, ownedFolderIds],
  );

  const ownedBaseItems: DashboardItem[] = useMemo(() => {
    const folderItems: DashboardItem[] = ownedFolders.map((folder) => ({
      id: folder.id,
      type: 'folder',
      title: folder.name,
      icon: folder.icon,
      updatedAt: folder.updatedAt,
      activityAt: folder.updatedAt,
      ownerId: folder.ownerId,
      createdBy: folder.createdBy,
      canMove: true,
    }));
    const pageItems: DashboardItem[] = ownedRootPages.map((page) => ({
      id: page.id,
      type: 'page',
      title: page.title,
      icon: page.icon,
      updatedAt: page.updatedAt,
      activityAt: page.updatedAt,
      coverType: page.coverType,
      coverValue: page.coverValue,
      ownerId: page.ownerId,
      createdBy: page.createdBy,
      canMove: true,
    }));
    return [...folderItems, ...pageItems];
  }, [ownedFolders, ownedRootPages]);

  const workspaceOwnerIds = useMemo(
    () => new Set((workspaceMemberships ?? []).map((membership) => membership.ownerId)),
    [workspaceMemberships],
  );
  const workspaceAdminOwnerIds = useMemo(
    () =>
      new Set(
        (workspaceMemberships ?? [])
          .filter((membership) => membership.role === 'admin')
          .map((membership) => membership.ownerId),
      ),
    [workspaceMemberships],
  );
  const workspaceBaseItems = useMemo<DashboardItem[]>(() => {
    const folderItems = (folders ?? [])
      .filter(
        (folder) =>
          folder.workspaceAccess === true &&
          !!folder.ownerId &&
          workspaceOwnerIds.has(folder.ownerId),
      )
      .map((folder) => ({
        id: folder.id,
        type: 'folder' as const,
        title: folder.name,
        icon: folder.icon,
        updatedAt: folder.updatedAt,
        activityAt: folder.updatedAt,
        ownerId: folder.ownerId,
        createdBy: folder.createdBy,
        userPermission: folder.userPermission,
        shareSource: 'workspace' as const,
        canMove:
          folder.userPermission === 'admin' &&
          !!folder.ownerId &&
          workspaceAdminOwnerIds.has(folder.ownerId),
      }));
    const pageItems = (pages ?? [])
      .filter(
        (page) =>
          page.parentId === null &&
          page.workspaceAccess === true &&
          !!page.ownerId &&
          workspaceOwnerIds.has(page.ownerId),
      )
      .map((page) => ({
        id: page.id,
        type: 'page' as const,
        title: page.title,
        icon: page.icon,
        updatedAt: page.updatedAt,
        activityAt: page.updatedAt,
        coverType: page.coverType,
        coverValue: page.coverValue,
        ownerId: page.ownerId,
        createdBy: page.createdBy,
        userPermission: page.userPermission,
        shareSource: 'workspace' as const,
        canMove:
          page.userPermission === 'admin' &&
          !!page.ownerId &&
          workspaceAdminOwnerIds.has(page.ownerId),
      }));
    return [...folderItems, ...pageItems];
  }, [folders, pages, workspaceOwnerIds, workspaceAdminOwnerIds]);

  const workspaceAccessibleFolderIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: FolderTreeNode[]) => {
      for (const folder of nodes) {
        if (folder.workspaceAccess === true) ids.add(folder.id);
        walk(folder.children);
      }
    };
    walk(folders ?? []);
    return ids;
  }, [folders]);
  const workspaceAccessiblePageIds = useMemo(
    () =>
      new Set((pages ?? []).filter((page) => page.workspaceAccess === true).map((page) => page.id)),
    [pages],
  );
  const sharedBaseItems = useMemo(
    () => [
      ...(sharedWithMe ?? []).map((item) => {
        const explorerItem = sharedItemToExplorerItem(item);
        const hasWorkspaceFallback =
          item.entityType === 'page'
            ? workspaceAccessiblePageIds.has(item.entityId)
            : workspaceAccessibleFolderIds.has(item.entityId);
        return {
          ...explorerItem,
          shareSource: resolveRemovalShareSource(explorerItem.shareSource, hasWorkspaceFallback),
        };
      }),
      ...workspaceBaseItems,
    ],
    [sharedWithMe, workspaceAccessibleFolderIds, workspaceAccessiblePageIds, workspaceBaseItems],
  );

  const filteredBaseItems = useMemo(() => {
    const items =
      activeFilter === 'owned-by-me'
        ? ownedBaseItems
        : activeFilter === 'shared-with-me'
          ? sharedBaseItems
          : [...ownedBaseItems, ...sharedBaseItems];

    const uniqueItems = Array.from(
      new Map(items.map((item) => [`${item.type}:${item.id}`, item])).values(),
    );

    return uniqueItems.sort(sortByActivityDesc);
  }, [activeFilter, ownedBaseItems, sharedBaseItems]);

  const pageIds = useMemo(
    () => filteredBaseItems.filter((item) => item.type === 'page').map((item) => item.id),
    [filteredBaseItems],
  );
  const { data: collaboratorsMap } = usePageCollaborators(pageIds);

  const folderIds = useMemo(
    () => filteredBaseItems.filter((item) => item.type === 'folder').map((item) => item.id),
    [filteredBaseItems],
  );
  const { data: folderCollaboratorsMap } = useFolderCollaborators(folderIds);

  const refreshedItems: DashboardItem[] = useMemo(
    () =>
      filteredBaseItems.map((item) => ({
        ...item,
        ...(item.type === 'page' && collaboratorsMap?.[item.id]
          ? { collaborators: collaboratorsMap[item.id] }
          : {}),
        ...(item.type === 'folder' && folderCollaboratorsMap?.[item.id]
          ? { collaborators: folderCollaboratorsMap[item.id] }
          : {}),
      })),
    [filteredBaseItems, collaboratorsMap, folderCollaboratorsMap],
  );
  const allItems = useStableValueWhile(refreshedItems, bulkRemoveMutation.isPending);
  const editingItem = editingTarget
    ? refreshedItems.find(
        (item) => item.type === editingTarget.kind && item.id === editingTarget.id,
      )
    : undefined;
  const canRenameEditingTarget = editingItem ? canRenameEntity(editingItem, currentUserId) : false;
  const renameCapabilityRef = useRef({ items: refreshedItems, currentUserId });
  renameCapabilityRef.current = { items: refreshedItems, currentUserId };

  useEffect(() => {
    if (editingTarget && editingItem && !canRenameEditingTarget) {
      setEditingTarget(null);
    }
  }, [canRenameEditingTarget, editingItem, editingTarget]);

  const hasSelection = selection.selectedCount > 0;

  const setFilter = (filter: DashboardFilter) => {
    setSearchParams(filter === 'all' ? {} : { filter });
    setShowFilterMenu(false);
  };

  const handleCreatePage = async () => {
    try {
      await entityCreation.createPageAndNavigate();
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handleCreateFolder = async () => {
    try {
      const folder = await entityCreation.createFolder();
      if (!folder) return;
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
    const { items, currentUserId: latestUserId } = renameCapabilityRef.current;
    const currentItem = items.find(
      (candidate) => candidate.type === item.type && candidate.id === item.id,
    );
    if (!currentItem || !canRenameEntity(currentItem, latestUserId)) return;
    setEditingTarget({ kind: currentItem.type, id: currentItem.id, value: currentItem.title });
  };

  const handleSaveRename = () => {
    if (!editingTarget) return;
    const { items, currentUserId: latestUserId } = renameCapabilityRef.current;
    const currentItem = items.find(
      (item) => item.type === editingTarget.kind && item.id === editingTarget.id,
    );
    if (!currentItem || !canRenameEntity(currentItem, latestUserId)) {
      setEditingTarget(null);
      return;
    }
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
        return {
          ...selected,
          ownerId: item?.ownerId ?? null,
          createdBy: item?.createdBy ?? null,
          userPermission: item?.userPermission ?? null,
          shareSource: item?.shareSource,
          canMove: item?.canMove ?? false,
        };
      }),
    [selection.selectedItems, allItems],
  );

  const selectedRemovalInput = useMemo(
    () => buildBulkRemovalInput(selectedItems, currentUserId),
    [selectedItems, currentUserId],
  );
  const selectedRemovalCounts = getBulkRemovalCounts(selectedRemovalInput);
  const selectedOwnerIds = new Set(selectedItems.map((item) => item.ownerId));
  const selectedOwnerId = selectedOwnerIds.size === 1 ? selectedItems[0]?.ownerId : undefined;
  const canMoveSelection =
    selectedItems.length > 0 &&
    selectedOwnerIds.size === 1 &&
    selectedItems.every((item) => item.canMove);
  const hasWorkspaceRootAccess =
    selectedOwnerId === currentUserId ||
    workspaceMemberships?.some(
      (membership) => membership.ownerId === selectedOwnerId && membership.role === 'admin',
    ) === true;
  const canMoveSelectionToRoot =
    hasWorkspaceRootAccess && selectedItems.every(preservesEffectiveOwnerAtRoot);
  const canRemoveSelection =
    selectedItems.length > 0 &&
    selectedRemovalCounts.trashCount + selectedRemovalCounts.removeFromViewCount > 0;
  const unremovableSelectionCount =
    selectedItems.length -
    selectedRemovalCounts.trashCount -
    selectedRemovalCounts.removeFromViewCount;

  const handleBulkDelete = async () => {
    try {
      const result = await bulkRemoveMutation.mutateAsync(selectedRemovalInput);
      if (!identityLifecycle.isActive()) return;
      for (const item of result.removedItems) selection.deselect(item.entityId);
      setRemovalFailure(
        result.failedItems.length > 0
          ? { message: formatBulkRemovalFailure(result), canRetry: canRetryBulkRemoval(result) }
          : null,
      );
    } catch {
      // Network-level failures are reported by the global mutation cache.
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
    const pageIdsToMove = selection.selectedItems.filter((i) => i.type === 'page').map((i) => i.id);
    const folderIdsToMove = selection.selectedItems
      .filter((i) => i.type === 'folder')
      .map((i) => i.id);

    try {
      if (pageIdsToMove.length > 0)
        await bulkMovePagesMutation.mutateAsync({
          pageIds: pageIdsToMove,
          parentId: targetFolderId,
        });
      if (!identityLifecycle.isActive()) return;
      if (folderIdsToMove.length > 0)
        await bulkMoveFoldersMutation.mutateAsync({
          folderIds: folderIdsToMove,
          parentId: targetFolderId,
        });
      if (!identityLifecycle.isActive()) return;
      selection.clear();
      setMoveDialogOpen(false);
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handlePaste = async () => {
    if (!clipboard.state.action || clipboard.state.items.length === 0) return;
    const currentParentId = null;

    try {
      if (clipboard.state.action === 'copy') {
        for (const item of clipboard.state.items) {
          if (!identityLifecycle.isActive()) return;
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
          if (!identityLifecycle.isActive()) return;
        }
        showSuccessToast('Pasted');
      } else if (clipboard.state.action === 'cut') {
        const pageIdsToMove = clipboard.state.items
          .filter((i) => i.type === 'page')
          .map((i) => i.id);
        const folderIdsToMove = clipboard.state.items
          .filter((i) => i.type === 'folder')
          .map((i) => i.id);
        if (pageIdsToMove.length > 0)
          await bulkMovePagesMutation.mutateAsync({
            pageIds: pageIdsToMove,
            parentId: currentParentId,
          });
        if (!identityLifecycle.isActive()) return;
        if (folderIdsToMove.length > 0)
          await bulkMoveFoldersMutation.mutateAsync({
            folderIds: folderIdsToMove,
            parentId: currentParentId,
          });
        if (!identityLifecycle.isActive()) return;
        clipboard.clear();
        showSuccessToast('Moved');
      }
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const isLoading = isPagesLoading || isFoldersLoading || isSharedLoading;
  const hasError = hasInitialQueryError([
    { data: pages, error: pagesError },
    { data: folders, error: foldersError },
    { data: sharedWithMe, error: sharedError },
    { data: workspaceMemberships, error: workspaceMembershipsError },
    { data: favorites, error: favoritesError },
  ]);
  const heading = FILTERS.find((filter) => filter.value === activeFilter)?.label ?? 'All';
  const emptyMessage =
    activeFilter === 'shared-with-me'
      ? 'Nothing has been shared with you yet.'
      : activeFilter === 'owned-by-me'
        ? 'Create a new page or folder to get started.'
        : 'Create or open a page to get started.';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 min-w-0">
          <span className="flex items-center gap-1">
            <HomeIcon size={14} />
            <span className="font-medium">Home</span>
          </span>
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
          <div className="relative" ref={filterMenuRef}>
            <button
              type="button"
              onClick={() => setShowFilterMenu((prev) => !prev)}
              className="flex items-center gap-1.5 h-7 px-3 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-lg text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer border border-zinc-200 dark:border-zinc-700"
            >
              <span>{heading}</span>
              <ChevronDown size={14} />
            </button>
            {showFilterMenu && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 p-1.5 flex flex-col animate-scale-in origin-top-right">
                {FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setFilter(filter.value)}
                    className={`flex items-center justify-between gap-2 px-2.5 py-2 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors ${
                      activeFilter === filter.value
                        ? 'text-zinc-900 dark:text-zinc-100 bg-black/5 dark:bg-white/10'
                        : 'text-zinc-700 dark:text-zinc-300'
                    }`}
                  >
                    <span>{filter.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
              aria-label="Open new item menu"
              className="flex items-center px-1.5 h-7 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-r-lg text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer border border-zinc-200 dark:border-zinc-700"
            >
              <ChevronDown size={14} />
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
        </div>
      </div>

      {hasError ? (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-md flex items-center justify-between">
          <span>Failed to load items.</span>
          <button
            type="button"
            onClick={() => {
              void Promise.all([
                refetchPages(),
                refetchFolders(),
                refetchSharedWithMe(),
                refetchWorkspaceMemberships(),
                refetchFavorites(),
              ]);
            }}
            className="px-3 py-1 bg-red-100 dark:bg-red-900/40 hover:bg-red-200 dark:hover:bg-red-900/60 rounded text-sm transition-colors cursor-pointer"
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
          <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm">{emptyMessage}</p>
        </div>
      ) : viewMode === 'card' ? (
        <div className="space-y-8 animate-fade-in">
          <div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allItems.map((item, index) => (
                <ExplorerItem
                  key={`${item.type}-${item.id}`}
                  item={item}
                  viewMode="card"
                  isSelected={selection.isSelected(item.id)}
                  isFavorite={isFavorite(item)}
                  canSelect={!bulkRemoveMutation.isPending}
                  onSelect={(e) => {
                    e.stopPropagation();
                    selection.toggle({ id: item.id, type: item.type });
                  }}
                  onNavigate={(e) => handleItemClick(item, index, e)}
                  {...(canRenameEntity(item, currentUserId)
                    ? { onRename: () => handleRenameItem(item) }
                    : {})}
                  isEditing={
                    canRenameEditingTarget &&
                    editingTarget?.kind === item.type &&
                    editingTarget.id === item.id
                  }
                  editValue={editingTarget?.value ?? ''}
                  onEditChange={(value) =>
                    setEditingTarget((prev) => (prev ? { ...prev, value } : null))
                  }
                  onEditSave={handleSaveRename}
                  onEditKeyDown={handleEditKeyDown}
                  collaborators={filterOutSelf(item.collaborators ?? [])}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          <div>
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
                    isFavorite={isFavorite(item)}
                    canSelect={!bulkRemoveMutation.isPending}
                    onSelect={(e) => {
                      e.stopPropagation();
                      selection.toggle({ id: item.id, type: item.type });
                    }}
                    onNavigate={(e) => handleItemClick(item, index, e)}
                    {...(canRenameEntity(item, currentUserId)
                      ? { onRename: () => handleRenameItem(item) }
                      : {})}
                    isEditing={
                      canRenameEditingTarget &&
                      editingTarget?.kind === item.type &&
                      editingTarget.id === item.id
                    }
                    editValue={editingTarget?.value ?? ''}
                    onEditChange={(value) =>
                      setEditingTarget((prev) => (prev ? { ...prev, value } : null))
                    }
                    onEditSave={handleSaveRename}
                    onEditKeyDown={handleEditKeyDown}
                    collaborators={filterOutSelf(item.collaborators ?? [])}
                    showCheckboxes={hasSelection}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <SelectionToolbar
        selectedCount={selection.selectedCount}
        totalCount={allItems.length}
        clipboardCount={clipboard.state.items.length}
        onDelete={handleBulkDelete}
        onCopy={handleBulkCopy}
        onCut={handleBulkCut}
        onMove={handleBulkMove}
        canDelete={canRemoveSelection}
        trashCount={selectedRemovalCounts.trashCount}
        removeFromViewCount={selectedRemovalCounts.removeFromViewCount}
        unremovableCount={unremovableSelectionCount}
        removalFailureMessage={removalFailure?.message ?? null}
        canRetryRemoval={removalFailure?.canRetry ?? false}
        onDismissRemovalFailure={() => setRemovalFailure(null)}
        canMove={canMoveSelection}
        isRemoving={bulkRemoveMutation.isPending}
        onPaste={() => void handlePaste()}
        onSelectAll={() => selection.selectAll(allItems.map((i) => ({ id: i.id, type: i.type })))}
        onClear={() => {
          selection.clear();
          clipboard.clear();
        }}
      />

      <MoveDialog
        isOpen={moveDialogOpen}
        folders={folders ?? []}
        movingFolderIds={selection.selectedItems
          .filter((item) => item.type === 'folder')
          .map((item) => item.id)}
        {...(selectedOwnerId !== undefined ? { movingOwnerId: selectedOwnerId } : {})}
        allowRoot={canMoveSelectionToRoot}
        onClose={() => setMoveDialogOpen(false)}
        onConfirm={handleConfirmMove}
      />
    </div>
  );
}
