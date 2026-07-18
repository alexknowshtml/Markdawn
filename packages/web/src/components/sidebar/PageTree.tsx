import type { FolderTreeNode, PageTreeNode, SharedNavigationItem } from '@markdawn/shared';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Download,
  FilePlus2,
  FolderPlus,
  Home,
  LogOut,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useIdentityLifecycle, useIdentityNavigate } from '../../contexts/IdentityLifecycleContext';
import { useShareContext } from '../../contexts/ShareContext';
import { useIsBulkRemovalPending } from '../../hooks/use-bulk-actions';
import { useFavorites } from '../../hooks/use-favorites';
import { useCreateFolder, useFolderTree, useUpdateFolder } from '../../hooks/use-folders';
import {
  useCreatePage,
  useImportMarkdown,
  usePageTree,
  useRecentPages,
  useUpdatePage,
} from '../../hooks/use-pages';
import { useSharedWithMeTree } from '../../hooks/use-shared-with-me';
import { useLeaveWorkspace, useWorkspaceMemberships } from '../../hooks/use-workspace';
import { useAuth } from '../../hooks/useAuth';
import { useStableValueWhile } from '../../hooks/useStableValue';
import { canRenameEntity, useEntityDeletion } from '../../utils/entity-actions';
import { buildPagesByFolder, collectAllFolderIds, getRootPages } from '../../utils/page-tree';
import { showErrorToast } from '../../utils/toast';
import { buildFolderPath, buildPagePath, extractUuidFromSlug } from '../../utils/url';
import { PageTreeRow } from './PageTreeRow';

type EditingTarget =
  | { kind: 'page'; id: string; value: string }
  | { kind: 'folder'; id: string; value: string }
  | null;

const SIDEBAR_PREVIEW_LIMIT = 8;

const collectSharedNavigationFolderIds = (items: SharedNavigationItem[]): string[] => {
  const ids: string[] = [];
  const walk = (nodes: SharedNavigationItem[]) => {
    for (const item of nodes) {
      if (item.entityType !== 'folder') continue;
      ids.push(item.id);
      walk(item.children);
    }
  };
  walk(items);
  return ids;
};

export function PageTree() {
  const navigate = useIdentityNavigate();
  const identityLifecycle = useIdentityLifecycle();
  const params = useParams();
  const activePageId = params.slugAndId ? extractUuidFromSlug(params.slugAndId) : undefined;
  const { isAnonymous } = useShareContext();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;

  const {
    data: refreshedPages,
    isLoading: isPagesLoading,
    error: pagesError,
    refetch: refetchPages,
  } = usePageTree();
  const {
    data: refreshedFolders,
    isLoading: isFoldersLoading,
    error: foldersError,
    refetch: refetchFolders,
  } = useFolderTree();
  const {
    data: refreshedFavorites,
    error: favoritesError,
    refetch: refetchFavorites,
  } = useFavorites();
  const {
    data: refreshedRecentPages,
    error: recentsError,
    refetch: refetchRecents,
  } = useRecentPages(SIDEBAR_PREVIEW_LIMIT);
  const {
    data: refreshedSharedNavigation,
    error: sharedNavigationError,
    refetch: refetchSharedNavigation,
  } = useSharedWithMeTree();
  const {
    data: refreshedWorkspaceMemberships,
    error: workspaceMembershipsError,
    refetch: refetchWorkspaceMemberships,
  } = useWorkspaceMemberships();
  const leaveWorkspaceMutation = useLeaveWorkspace();
  const isBulkRemovalPending = useIsBulkRemovalPending();
  const pages = useStableValueWhile(refreshedPages, isBulkRemovalPending);
  const folders = useStableValueWhile(refreshedFolders, isBulkRemovalPending);
  const favorites = useStableValueWhile(refreshedFavorites, isBulkRemovalPending);
  const recentPages = useStableValueWhile(refreshedRecentPages, isBulkRemovalPending);
  const sharedNavigation = useStableValueWhile(refreshedSharedNavigation, isBulkRemovalPending);
  const workspaceMemberships = useStableValueWhile(
    refreshedWorkspaceMemberships,
    isBulkRemovalPending,
  );

  const favoriteKeys = useMemo(
    () => new Set(favorites?.map((fav) => `${fav.entityType}:${fav.entityId}`) ?? []),
    [favorites],
  );
  const isFavoriteEntity = useCallback(
    (entityType: 'folder' | 'page', entityId: string) =>
      favoriteKeys.has(`${entityType}:${entityId}`),
    [favoriteKeys],
  );

  const createPageMutation = useCreatePage();
  const updatePageMutation = useUpdatePage();
  const createFolderMutation = useCreateFolder();
  const updateFolderMutation = useUpdateFolder();
  const importMarkdownMutation = useImportMarkdown();

  const pageDeletion = useEntityDeletion({
    entityType: 'page',
    currentUserId,
  });

  const folderDeletion = useEntityDeletion({
    entityType: 'folder',
    currentUserId,
  });

  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  const [sharedCollapsed, setSharedCollapsed] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(new Set());
  const [ownedByMeCollapsed, setOwnedByMeCollapsed] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget>(null);
  const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);

  const handleCreateRootPage = useCallback(async () => {
    try {
      const newPage = await createPageMutation.mutateAsync({});
      if (!identityLifecycle.isActive()) return;
      navigate(buildPagePath(newPage.title, newPage.id));
      setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [navigate, createPageMutation, identityLifecycle]);

  const handleCreateRootFolder = useCallback(async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({});
      if (!identityLifecycle.isActive()) return;
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        next.add(folder.id);
        return next;
      });
      setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [createFolderMutation, identityLifecycle]);

  useEffect(() => {
    const onCreateNote = () => {
      void handleCreateRootPage();
    };

    const onCreateFolder = () => {
      void handleCreateRootFolder();
    };

    window.addEventListener('markdawn:create-note', onCreateNote);
    window.addEventListener('markdawn:create-folder', onCreateFolder);

    return () => {
      window.removeEventListener('markdawn:create-note', onCreateNote);
      window.removeEventListener('markdawn:create-folder', onCreateFolder);
    };
  }, [handleCreateRootPage, handleCreateRootFolder]);

  const pageById = useMemo(() => new Map((pages ?? []).map((page) => [page.id, page])), [pages]);

  const sharedNavigationByKey = useMemo(() => {
    const map = new Map<string, SharedNavigationItem>();
    const walk = (items: SharedNavigationItem[]) => {
      for (const item of items) {
        map.set(`${item.entityType}:${item.id}`, item);
        if (item.entityType === 'folder') walk(item.children);
      }
    };
    walk(sharedNavigation ?? []);
    return map;
  }, [sharedNavigation]);

  const folderById = useMemo(() => {
    const map = new Map<string, FolderTreeNode>();
    const walk = (nodes: FolderTreeNode[] | undefined) => {
      for (const folder of nodes ?? []) {
        map.set(folder.id, folder);
        walk(folder.children);
      }
    };
    walk(folders);
    return map;
  }, [folders]);

  const renamePageById = useMemo(
    () => new Map((refreshedPages ?? []).map((page) => [page.id, page])),
    [refreshedPages],
  );
  const renameFolderById = useMemo(() => {
    const map = new Map<string, FolderTreeNode>();
    const walk = (nodes: FolderTreeNode[] | undefined) => {
      for (const folder of nodes ?? []) {
        map.set(folder.id, folder);
        walk(folder.children);
      }
    };
    walk(refreshedFolders);
    return map;
  }, [refreshedFolders]);
  const renameSharedNavigationByKey = useMemo(() => {
    const map = new Map<string, SharedNavigationItem>();
    const walk = (items: SharedNavigationItem[]) => {
      for (const item of items) {
        map.set(`${item.entityType}:${item.id}`, item);
        if (item.entityType === 'folder') walk(item.children);
      }
    };
    walk(refreshedSharedNavigation ?? []);
    return map;
  }, [refreshedSharedNavigation]);

  const getRenameCapability = useCallback(
    (kind: 'page' | 'folder', id: string): { exists: boolean; allowed: boolean } => {
      const treeEntity = kind === 'page' ? renamePageById.get(id) : renameFolderById.get(id);
      const sharedEntity = renameSharedNavigationByKey.get(`${kind}:${id}`);
      const candidates = [
        ...(treeEntity ? [{ ...treeEntity, type: kind }] : []),
        ...(sharedEntity
          ? [
              {
                type: kind,
                ownerId: sharedEntity.ownerId,
                createdBy: sharedEntity.createdBy,
                userPermission: sharedEntity.userPermission,
              },
            ]
          : []),
      ];
      return {
        exists: candidates.length > 0,
        // If two live navigation queries momentarily disagree during a
        // downgrade, fail closed until both reflect rename access.
        allowed:
          candidates.length > 0 &&
          candidates.every((candidate) => canRenameEntity(candidate, currentUserId)),
      };
    },
    [currentUserId, renameFolderById, renamePageById, renameSharedNavigationByKey],
  );

  const editingCapability = editingTarget
    ? getRenameCapability(editingTarget.kind, editingTarget.id)
    : { exists: false, allowed: false };
  const renameCapabilityRef = useRef(getRenameCapability);
  renameCapabilityRef.current = getRenameCapability;

  useEffect(() => {
    if (editingTarget && editingCapability.exists && !editingCapability.allowed) {
      setEditingTarget(null);
    }
  }, [editingCapability.allowed, editingCapability.exists, editingTarget]);

  const ownedFolders = useMemo(() => {
    const filterOwned = (nodes: FolderTreeNode[]): FolderTreeNode[] =>
      nodes
        .filter((folder) => folder.ownerId === currentUserId)
        .map((folder) => ({ ...folder, children: filterOwned(folder.children ?? []) }));
    return filterOwned(folders ?? []);
  }, [folders, currentUserId]);

  const ownedPages = useMemo(
    () => (pages ?? []).filter((page) => page.ownerId === currentUserId),
    [pages, currentUserId],
  );

  const allFolderIds = useMemo(() => collectAllFolderIds(ownedFolders), [ownedFolders]);
  const sharedNavigationFolderIds = useMemo(
    () => collectSharedNavigationFolderIds(sharedNavigation ?? []),
    [sharedNavigation],
  );
  const visibleFolderIds = useMemo(() => new Set(allFolderIds), [allFolderIds]);

  const pagesByFolder = useMemo(
    () => buildPagesByFolder(ownedPages, visibleFolderIds),
    [ownedPages, visibleFolderIds],
  );

  const rootPages = useMemo(
    () => getRootPages(ownedPages, visibleFolderIds),
    [ownedPages, visibleFolderIds],
  );
  const visibleRecentPages = useMemo(
    () => (recentPages ?? []).filter((page) => pageById.has(page.id)),
    [recentPages, pageById],
  );

  const buildFoldersByParentMap = useCallback((nodes: FolderTreeNode[]) => {
    const map = new Map<string | null, FolderTreeNode[]>();
    const walk = (folderNodes: FolderTreeNode[]) => {
      for (const folder of folderNodes) {
        const key = folder.parentId ?? null;
        const list = map.get(key) ?? [];
        list.push(folder);
        map.set(key, list);
        if (folder.children && folder.children.length > 0) {
          walk(folder.children);
        }
      }
    };
    walk(nodes);
    return map;
  }, []);

  const foldersByParent = useMemo(
    () => buildFoldersByParentMap(ownedFolders),
    [buildFoldersByParentMap, ownedFolders],
  );

  const allFolderIdsSet = useMemo(() => new Set(folderById.keys()), [folderById]);
  const allPagesByFolder = useMemo(
    () => buildPagesByFolder(pages ?? [], allFolderIdsSet),
    [pages, allFolderIdsSet],
  );
  const workspaceGroups = useMemo(
    () =>
      (workspaceMemberships ?? []).map((membership) => ({
        ...membership,
        folders: (folders ?? []).filter(
          (folder) => folder.ownerId === membership.ownerId && folder.workspaceAccess === true,
        ),
        pages: (pages ?? []).filter(
          (page) =>
            page.ownerId === membership.ownerId &&
            page.workspaceAccess === true &&
            page.parentId === null,
        ),
      })),
    [workspaceMemberships, folders, pages],
  );
  const workspaceFolderIds = useMemo(
    () => workspaceGroups.flatMap((group) => collectAllFolderIds(group.folders)),
    [workspaceGroups],
  );
  const sidebarFolderIds = useMemo(
    () =>
      Array.from(new Set([...allFolderIds, ...sharedNavigationFolderIds, ...workspaceFolderIds])),
    [allFolderIds, sharedNavigationFolderIds, workspaceFolderIds],
  );

  useEffect(() => {
    if (!hasInitializedExpansion && sidebarFolderIds.length > 0) {
      setExpandedFolderIds(new Set(sidebarFolderIds));
      setHasInitializedExpansion(true);
    }
  }, [sidebarFolderIds, hasInitializedExpansion]);

  const toggleFolderExpanded = (folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const isAllExpanded =
    sidebarFolderIds.length > 0 && sidebarFolderIds.every((id) => expandedFolderIds.has(id));

  const toggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedFolderIds(new Set());
    } else {
      setExpandedFolderIds(new Set(sidebarFolderIds));
    }
  };

  const handleCreatePageInFolder = async (folderId: string) => {
    try {
      const newPage = await createPageMutation.mutateAsync({ parentId: folderId });
      if (!identityLifecycle.isActive()) return;
      navigate(buildPagePath(newPage.title, newPage.id));
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        next.add(folderId);
        return next;
      });
      setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  };

  const handleDeletePage = async (pageId: string) => {
    const page = pageById.get(pageId);
    const isViewingDeletedPage = activePageId === pageId;
    await pageDeletion.handleDelete(
      {
        id: pageId,
        type: 'page',
        ownerId: page?.ownerId,
        createdBy: page?.createdBy,
        userPermission: page?.userPermission,
      },
      { force: false },
    );
    if (!identityLifecycle.isActive()) return;
    if (isViewingDeletedPage) {
      navigate('/app');
    }
  };

  const handleImportMarkdown = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.md')) {
      showErrorToast('Please select a markdown file (.md)');
      event.target.value = '';
      return;
    }

    try {
      const newPage = await importMarkdownMutation.mutateAsync({ file });
      if (!identityLifecycle.isActive()) return;
      navigate(buildPagePath(newPage.title, newPage.id));
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
    event.target.value = '';
  };

  const handleDeleteFolder = async (folderId: string, childFolders: number, childPages: number) => {
    const folder = folderById.get(folderId);
    const hasChildren = childFolders > 0 || childPages > 0;
    await folderDeletion.handleDelete(
      {
        id: folderId,
        type: 'folder',
        ownerId: folder?.ownerId,
        createdBy: folder?.createdBy,
        userPermission: folder?.userPermission,
      },
      { force: hasChildren },
    );
  };

  const beginRenameFolder = (folder: FolderTreeNode) => {
    if (!canRenameEntity({ ...folder, type: 'folder' }, currentUserId)) return;
    setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
  };

  const beginRenamePage = (page: PageTreeNode) => {
    if (!canRenameEntity({ ...page, type: 'page' }, currentUserId)) return;
    setEditingTarget({ kind: 'page', id: page.id, value: page.title });
  };

  const saveRename = () => {
    if (!editingTarget) {
      return;
    }
    if (!renameCapabilityRef.current(editingTarget.kind, editingTarget.id).allowed) {
      setEditingTarget(null);
      return;
    }
    const trimmed = editingTarget.value.trim();

    if (editingTarget.kind === 'folder') {
      const finalName = trimmed.length > 0 ? trimmed : 'New Folder';
      updateFolderMutation.mutate(
        { folderId: editingTarget.id, updates: { name: finalName } },
        { onSettled: () => setEditingTarget(null) },
      );
      return;
    }

    const finalTitle = trimmed.length > 0 ? trimmed : 'Untitled';
    updatePageMutation.mutate(
      { pageId: editingTarget.id, updates: { title: finalTitle } },
      { onSettled: () => setEditingTarget(null) },
    );
  };

  const onRenameKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      saveRename();
      return;
    }
    if (event.key === 'Escape') {
      setEditingTarget(null);
    }
  };

  const renderFolderBranch = (folder: FolderTreeNode, depth = 0) => {
    const childFolders = foldersByParent.get(folder.id) ?? [];
    const childPages = pagesByFolder.get(folder.id) ?? [];
    const isExpanded = expandedFolderIds.has(folder.id);
    const isEditingFolder =
      editingCapability.allowed &&
      editingTarget?.kind === 'folder' &&
      editingTarget.id === folder.id;

    return (
      <div key={`folder-${folder.id}`}>
        <PageTreeRow
          id={folder.id}
          title={folder.name}
          icon={folder.icon}
          ownerId={folder.ownerId}
          createdBy={folder.createdBy}
          userPermission={folder.userPermission}
          canMove={true}
          depth={depth}
          hasChildren={childFolders.length > 0 || childPages.length > 0}
          isExpanded={isExpanded}
          onToggleExpand={() => toggleFolderExpanded(folder.id)}
          {...(folder.userPermission === 'admin'
            ? { onCreateChild: () => handleCreatePageInFolder(folder.id) }
            : {})}
          onDelete={() => handleDeleteFolder(folder.id, childFolders.length, childPages.length)}
          {...(folder.userPermission === 'admin'
            ? { onRename: () => beginRenameFolder(folder) }
            : {})}
          onNavigate={() => navigate(buildFolderPath(folder.name, folder.id))}
          isEditing={isEditingFolder}
          isFolder={true}
          editTitle={isEditingFolder ? editingTarget.value : folder.name}
          onEditChange={(value) => setEditingTarget({ kind: 'folder', id: folder.id, value })}
          onEditSave={() => {
            saveRename();
          }}
          onEditKeyDown={onRenameKeyDown}
        />
        {isExpanded && (
          <>
            {childFolders.map((childFolder) => renderFolderBranch(childFolder, depth + 1))}
            {childPages.map((page) => {
              const isEditingPage =
                editingCapability.allowed &&
                editingTarget?.kind === 'page' &&
                editingTarget.id === page.id;
              return (
                <PageTreeRow
                  key={page.id}
                  id={page.id}
                  title={page.title}
                  icon={page.icon}
                  ownerId={page.ownerId}
                  createdBy={page.createdBy}
                  userPermission={page.userPermission}
                  canMove={true}
                  depth={depth + 1}
                  isActive={activePageId === page.id}
                  isFavorite={isFavoriteEntity('page', page.id)}
                  onDelete={() => handleDeletePage(page.id)}
                  onRename={() => beginRenamePage(page)}
                  isEditing={isEditingPage}
                  editTitle={isEditingPage ? editingTarget.value : page.title}
                  onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
                  onEditSave={() => {
                    saveRename();
                  }}
                  onEditKeyDown={onRenameKeyDown}
                />
              );
            })}
          </>
        )}
      </div>
    );
  };

  const renderWorkspacePage = (page: PageTreeNode, depth = 0, sourceIsAdmin = false): ReactNode => {
    const isEditingPage =
      editingCapability.allowed && editingTarget?.kind === 'page' && editingTarget.id === page.id;
    const canRename = page.userPermission === 'edit' || page.userPermission === 'admin';
    return (
      <PageTreeRow
        key={`workspace-page-${page.id}`}
        id={page.id}
        title={page.title}
        icon={page.icon}
        ownerId={page.ownerId}
        createdBy={page.createdBy}
        userPermission={page.userPermission}
        shareSource="workspace"
        canMove={page.userPermission === 'admin' && sourceIsAdmin}
        depth={depth}
        isActive={activePageId === page.id}
        isFavorite={isFavoriteEntity('page', page.id)}
        onDelete={() => handleDeletePage(page.id)}
        {...(canRename ? { onRename: () => beginRenamePage(page) } : {})}
        isEditing={isEditingPage}
        editTitle={isEditingPage ? editingTarget.value : page.title}
        onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
        onEditSave={() => {
          saveRename();
        }}
        onEditKeyDown={onRenameKeyDown}
      />
    );
  };

  const renderWorkspaceFolder = (
    folder: FolderTreeNode,
    workspaceOwnerId: string,
    depth = 0,
    sourceIsAdmin = false,
  ): ReactNode => {
    const childFolders = (folder.children ?? []).filter(
      (child) => child.ownerId === workspaceOwnerId && child.workspaceAccess === true,
    );
    const childPages = (allPagesByFolder.get(folder.id) ?? []).filter(
      (page) => page.ownerId === workspaceOwnerId && page.workspaceAccess === true,
    );
    const isExpanded = expandedFolderIds.has(folder.id);
    const isEditingFolder =
      editingCapability.allowed &&
      editingTarget?.kind === 'folder' &&
      editingTarget.id === folder.id;
    const isAdmin = folder.userPermission === 'admin';

    return (
      <div key={`workspace-folder-${folder.id}`}>
        <PageTreeRow
          id={folder.id}
          title={folder.name}
          icon={folder.icon}
          ownerId={folder.ownerId}
          createdBy={folder.createdBy}
          userPermission={folder.userPermission}
          shareSource="workspace"
          canMove={isAdmin && sourceIsAdmin}
          depth={depth}
          hasChildren={childFolders.length > 0 || childPages.length > 0}
          isExpanded={isExpanded}
          isFavorite={isFavoriteEntity('folder', folder.id)}
          onToggleExpand={() => toggleFolderExpanded(folder.id)}
          {...(isAdmin ? { onCreateChild: () => handleCreatePageInFolder(folder.id) } : {})}
          onDelete={() => handleDeleteFolder(folder.id, childFolders.length, childPages.length)}
          {...(isAdmin ? { onRename: () => beginRenameFolder(folder) } : {})}
          onNavigate={() => navigate(buildFolderPath(folder.name, folder.id))}
          isEditing={isEditingFolder}
          isFolder={true}
          editTitle={isEditingFolder ? editingTarget.value : folder.name}
          onEditChange={(value) => setEditingTarget({ kind: 'folder', id: folder.id, value })}
          onEditSave={() => {
            saveRename();
          }}
          onEditKeyDown={onRenameKeyDown}
        />
        {isExpanded && (
          <>
            {childFolders.map((child) =>
              renderWorkspaceFolder(child, workspaceOwnerId, depth + 1, isAdmin),
            )}
            {childPages.map((page) => renderWorkspacePage(page, depth + 1, isAdmin))}
          </>
        )}
      </div>
    );
  };

  const renderSharedNavigationItem = (
    item: SharedNavigationItem,
    depth = 0,
    sourceIsAdmin = false,
  ): ReactNode => {
    if (item.entityType === 'folder') {
      const isExpanded = expandedFolderIds.has(item.id);
      const isEditingFolder =
        editingCapability.allowed &&
        editingTarget?.kind === 'folder' &&
        editingTarget.id === item.id;
      const canCreateChild = item.userPermission === 'admin';
      return (
        <div key={`shared-folder-${item.id}`}>
          <PageTreeRow
            id={item.id}
            title={item.title}
            icon={item.icon}
            ownerId={item.ownerId}
            createdBy={item.createdBy}
            userPermission={item.userPermission}
            shareSource={item.source}
            canMove={item.userPermission === 'admin' && sourceIsAdmin}
            depth={depth}
            hasChildren={item.children.length > 0}
            isExpanded={isExpanded}
            isFavorite={isFavoriteEntity('folder', item.id)}
            onToggleExpand={() => toggleFolderExpanded(item.id)}
            {...(canCreateChild ? { onCreateChild: () => handleCreatePageInFolder(item.id) } : {})}
            onDelete={() => {
              void folderDeletion.handleDelete({
                id: item.id,
                type: 'folder',
                ownerId: item.ownerId,
                createdBy: item.createdBy,
                userPermission: item.userPermission,
                shareSource: item.source,
              });
            }}
            {...(item.userPermission === 'admin'
              ? {
                  onRename: () =>
                    setEditingTarget({ kind: 'folder', id: item.id, value: item.title }),
                }
              : {})}
            onNavigate={() => navigate(buildFolderPath(item.title, item.id))}
            isEditing={isEditingFolder}
            isFolder={true}
            editTitle={isEditingFolder ? editingTarget.value : item.title}
            onEditChange={(value) => setEditingTarget({ kind: 'folder', id: item.id, value })}
            onEditSave={() => {
              saveRename();
            }}
            onEditKeyDown={onRenameKeyDown}
          />
          {isExpanded &&
            item.children.map((child) =>
              renderSharedNavigationItem(child, depth + 1, item.userPermission === 'admin'),
            )}
        </div>
      );
    }

    const isEditingPage =
      editingCapability.allowed && editingTarget?.kind === 'page' && editingTarget.id === item.id;
    return (
      <PageTreeRow
        key={`shared-page-${item.id}`}
        id={item.id}
        title={item.title}
        icon={item.icon}
        ownerId={item.ownerId}
        createdBy={item.createdBy}
        userPermission={item.userPermission}
        shareSource={item.source}
        canMove={item.userPermission === 'admin' && sourceIsAdmin}
        depth={depth}
        isActive={activePageId === item.id}
        isFavorite={isFavoriteEntity('page', item.id)}
        onDelete={() => {
          void pageDeletion.handleDelete({
            id: item.id,
            type: 'page',
            ownerId: item.ownerId,
            createdBy: item.createdBy,
            userPermission: item.userPermission,
            shareSource: item.source,
          });
        }}
        onRename={
          canRenameEntity(
            {
              type: 'page',
              ownerId: item.ownerId,
              createdBy: item.createdBy,
              userPermission: item.userPermission,
            },
            currentUserId,
          )
            ? () => setEditingTarget({ kind: 'page', id: item.id, value: item.title })
            : undefined
        }
        isEditing={isEditingPage}
        editTitle={isEditingPage ? editingTarget.value : item.title}
        onEditChange={(value) => setEditingTarget({ kind: 'page', id: item.id, value })}
        onEditSave={() => {
          saveRename();
        }}
        onEditKeyDown={onRenameKeyDown}
      />
    );
  };

  if (isPagesLoading || isFoldersLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center h-24 text-zinc-500 dark:text-zinc-400 text-sm">
          Loading...
        </div>
      </div>
    );
  }

  if (isAnonymous) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          <div className="flex items-center justify-center gap-1 mb-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
              title="Go to home"
            >
              <Home size={16} />
            </button>
          </div>
          <div className="px-3 py-4 text-center">
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
              Sign in to access your pages
            </p>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors cursor-pointer"
            >
              Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (
    pagesError ||
    foldersError ||
    favoritesError ||
    recentsError ||
    sharedNavigationError ||
    workspaceMembershipsError
  ) {
    return (
      <div
        role="alert"
        className="m-4 space-y-2 rounded-md border border-red-200 bg-zinc-100 p-3 text-sm text-red-500 dark:border-red-900/30 dark:bg-zinc-800/50"
      >
        <p>Failed to load navigation.</p>
        <button
          type="button"
          onClick={() => {
            void Promise.all([
              refetchPages(),
              refetchFolders(),
              refetchFavorites(),
              refetchRecents(),
              refetchSharedNavigation(),
              refetchWorkspaceMemberships(),
            ]);
          }}
          className="rounded border border-red-200 px-2 py-1 text-xs hover:bg-red-50 dark:border-red-900/40 dark:hover:bg-red-950/30 cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  const rootFolders = ownedFolders;
  const directSharedNavigation = (sharedNavigation ?? []).filter((item) => {
    const workspaceAccess =
      item.entityType === 'folder'
        ? folderById.get(item.id)?.workspaceAccess
        : pageById.get(item.id)?.workspaceAccess;
    return workspaceAccess !== true;
  });
  const sharedPreview = directSharedNavigation.slice(0, SIDEBAR_PREVIEW_LIMIT);
  const hasMoreShared = directSharedNavigation.length > SIDEBAR_PREVIEW_LIMIT;
  const visibleWorkspaceGroups = workspaceGroups;
  const hasSharedContent = sharedPreview.length > 0 || visibleWorkspaceGroups.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-2 pt-2 pb-1">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => {
              navigate('/app');
            }}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title="Go to home"
            data-testid="home-btn"
          >
            <Home size={16} />
          </button>
          <label
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title="Import markdown file"
          >
            <input type="file" accept=".md" className="hidden" onChange={handleImportMarkdown} />
            <Download size={16} />
          </label>
          <button
            type="button"
            onClick={() => {
              void handleCreateRootFolder();
            }}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title="Create folder (Ctrl/Cmd+Shift+N)"
            data-testid="new-folder-btn"
          >
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCreateRootPage();
            }}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title="Create note (Ctrl/Cmd+N)"
            data-testid="new-page-btn"
          >
            <FilePlus2 size={16} />
          </button>
          <button
            type="button"
            onClick={toggleExpandAll}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title={isAllExpanded ? 'Collapse all folders' : 'Expand all folders'}
            data-testid="toggle-expand-all-btn"
          >
            {isAllExpanded ? <ChevronsUp size={16} /> : <ChevronsDown size={16} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {favorites && favorites.length > 0 && (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setFavoritesCollapsed((prev) => !prev)}
              aria-expanded={!favoritesCollapsed}
              className="flex items-center px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
            >
              {favoritesCollapsed ? (
                <ChevronRight size={14} className="mr-1 shrink-0" />
              ) : (
                <ChevronDown size={14} className="mr-1 shrink-0" />
              )}
              <span>Favorites</span>
            </button>
            {!favoritesCollapsed && (
              <div className="space-y-0.5">
                {favorites.map((fav) => {
                  const isFolder = fav.entityType === 'folder';
                  const favPage = isFolder ? undefined : pageById.get(fav.entityId);
                  const favFolder = isFolder ? folderById.get(fav.entityId) : undefined;
                  const sharedItem = sharedNavigationByKey.get(`${fav.entityType}:${fav.entityId}`);
                  const shareSource =
                    sharedItem?.source ??
                    (favPage?.workspaceAccess === true || favFolder?.workspaceAccess === true
                      ? 'workspace'
                      : undefined);
                  const childFolders = favFolder?.children.length ?? 0;
                  const childPages = pagesByFolder.get(fav.entityId)?.length ?? 0;
                  const isEditing =
                    editingCapability.allowed &&
                    editingTarget?.kind === fav.entityType &&
                    editingTarget.id === fav.entityId;
                  return (
                    <PageTreeRow
                      key={`${fav.entityType}-${fav.entityId}`}
                      id={fav.entityId}
                      title={fav.title}
                      icon={fav.icon}
                      ownerId={fav.ownerId ?? favPage?.ownerId ?? favFolder?.ownerId ?? null}
                      createdBy={favPage?.createdBy ?? favFolder?.createdBy ?? null}
                      userPermission={favPage?.userPermission ?? favFolder?.userPermission ?? null}
                      {...(shareSource ? { shareSource } : {})}
                      canMove={
                        (fav.ownerId ?? favPage?.ownerId ?? favFolder?.ownerId) === currentUserId
                      }
                      isFolder={isFolder}
                      isActive={!isFolder && activePageId === fav.entityId}
                      isFavorite={true}
                      onNavigate={
                        isFolder
                          ? () => navigate(buildFolderPath(fav.title, fav.entityId))
                          : undefined
                      }
                      onDelete={() => {
                        if (isFolder) {
                          void handleDeleteFolder(fav.entityId, childFolders, childPages);
                        } else {
                          void handleDeletePage(fav.entityId);
                        }
                      }}
                      onRename={
                        favPage
                          ? () => beginRenamePage(favPage)
                          : favFolder
                            ? () => beginRenameFolder(favFolder)
                            : undefined
                      }
                      isEditing={isEditing}
                      editTitle={isEditing ? editingTarget.value : fav.title}
                      onEditChange={(value) =>
                        setEditingTarget({ kind: fav.entityType, id: fav.entityId, value })
                      }
                      onEditSave={saveRename}
                      onEditKeyDown={onRenameKeyDown}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {visibleRecentPages.length > 0 && (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setRecentsCollapsed((prev) => !prev)}
              aria-expanded={!recentsCollapsed}
              className="flex items-center px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
            >
              {recentsCollapsed ? (
                <ChevronRight size={14} className="mr-1 shrink-0" />
              ) : (
                <ChevronDown size={14} className="mr-1 shrink-0" />
              )}
              <span>Recents</span>
            </button>
            {!recentsCollapsed && (
              <div className="space-y-0.5">
                {visibleRecentPages.map((page) => {
                  const treePage = pageById.get(page.id);
                  const sharedItem = sharedNavigationByKey.get(`page:${page.id}`);
                  const shareSource =
                    sharedItem?.source ??
                    (treePage?.workspaceAccess === true ? 'workspace' : undefined);
                  const isEditing =
                    editingCapability.allowed &&
                    editingTarget?.kind === 'page' &&
                    editingTarget.id === page.id;
                  return (
                    <PageTreeRow
                      key={page.id}
                      id={page.id}
                      title={page.title}
                      icon={page.icon}
                      ownerId={page.ownerId}
                      createdBy={page.createdBy}
                      userPermission={treePage?.userPermission ?? null}
                      {...(shareSource ? { shareSource } : {})}
                      canMove={page.ownerId === currentUserId}
                      isActive={activePageId === page.id}
                      isFavorite={isFavoriteEntity('page', page.id)}
                      onDelete={() => handleDeletePage(page.id)}
                      onRename={treePage ? () => beginRenamePage(treePage) : undefined}
                      isEditing={isEditing}
                      editTitle={isEditing ? editingTarget.value : page.title}
                      onEditChange={(value) =>
                        setEditingTarget({ kind: 'page', id: page.id, value })
                      }
                      onEditSave={saveRename}
                      onEditKeyDown={onRenameKeyDown}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {hasSharedContent && (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setSharedCollapsed((prev) => !prev)}
              aria-expanded={!sharedCollapsed}
              className="flex items-center px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
            >
              {sharedCollapsed ? (
                <ChevronRight size={14} className="mr-1 shrink-0" />
              ) : (
                <ChevronDown size={14} className="mr-1 shrink-0" />
              )}
              <span>Shared With Me</span>
            </button>
            {!sharedCollapsed && (
              <div className="space-y-1">
                {visibleWorkspaceGroups.map((group) => {
                  const isCollapsed = collapsedWorkspaceIds.has(group.ownerId);
                  return (
                    <div key={`workspace-${group.ownerId}`}>
                      <div className="flex items-center gap-1 px-3 py-1">
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedWorkspaceIds((previous) => {
                              const next = new Set(previous);
                              if (next.has(group.ownerId)) next.delete(group.ownerId);
                              else next.add(group.ownerId);
                              return next;
                            })
                          }
                          className="flex min-w-0 flex-1 items-center text-left text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
                        >
                          {isCollapsed ? (
                            <ChevronRight size={13} className="mr-1 shrink-0" />
                          ) : (
                            <ChevronDown size={13} className="mr-1 shrink-0" />
                          )}
                          <span className="truncate">
                            {group.ownerName
                              ? `${group.ownerName}'s Workspace`
                              : 'Shared Workspace'}
                          </span>
                        </button>
                        <button
                          type="button"
                          title="Leave workspace"
                          aria-label={`Leave ${group.ownerName ?? 'workspace'}`}
                          disabled={leaveWorkspaceMutation.isPending || !currentUserId}
                          onClick={() => {
                            if (!currentUserId) return;
                            leaveWorkspaceMutation.mutate({
                              ownerId: group.ownerId,
                              memberId: currentUserId,
                            });
                          }}
                          className="rounded p-1 text-zinc-400 hover:bg-black/5 hover:text-red-600 disabled:opacity-40 dark:hover:bg-white/10 cursor-pointer"
                        >
                          <LogOut size={12} />
                        </button>
                      </div>
                      {!isCollapsed && (
                        <div className="space-y-0.5">
                          {group.folders.map((folder) =>
                            renderWorkspaceFolder(folder, group.ownerId, 0, group.role === 'admin'),
                          )}
                          {group.pages.map((page) =>
                            renderWorkspacePage(page, 0, group.role === 'admin'),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {sharedPreview.map((item) => renderSharedNavigationItem(item))}
                {hasMoreShared && (
                  <button
                    type="button"
                    onClick={() => navigate('/app?filter=shared-with-me')}
                    className="w-full px-4 py-1.5 text-left text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
                  >
                    View more
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setOwnedByMeCollapsed((prev) => !prev)}
            aria-expanded={!ownedByMeCollapsed}
            className="flex items-center px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
          >
            {ownedByMeCollapsed ? (
              <ChevronRight size={14} className="mr-1 shrink-0" />
            ) : (
              <ChevronDown size={14} className="mr-1 shrink-0" />
            )}
            <span>Owned By Me</span>
          </button>
          {!ownedByMeCollapsed && (
            <div className="space-y-0.5">
              {rootFolders.map((folder) => renderFolderBranch(folder, 0))}
              {rootPages.map((page) => {
                const isEditingPage =
                  editingCapability.allowed &&
                  editingTarget?.kind === 'page' &&
                  editingTarget.id === page.id;
                return (
                  <PageTreeRow
                    key={page.id}
                    id={page.id}
                    title={page.title}
                    icon={page.icon}
                    ownerId={page.ownerId}
                    createdBy={page.createdBy}
                    userPermission={page.userPermission}
                    canMove={true}
                    isActive={activePageId === page.id}
                    isFavorite={isFavoriteEntity('page', page.id)}
                    onDelete={() => handleDeletePage(page.id)}
                    onRename={() => beginRenamePage(page)}
                    isEditing={isEditingPage}
                    editTitle={isEditingPage ? editingTarget.value : page.title}
                    onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
                    onEditSave={() => {
                      saveRename();
                    }}
                    onEditKeyDown={onRenameKeyDown}
                  />
                );
              })}
              {rootFolders.length === 0 && rootPages.length === 0 && (
                <div className="pl-10 pr-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                  No notes yet
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
