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
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useShareContext } from '../../contexts/ShareContext';
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
import { useAuth } from '../../hooks/useAuth';
import { useEntityDeletion } from '../../utils/entity-actions';
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
  const navigate = useNavigate();
  const params = useParams();
  const activePageId = params.slugAndId ? extractUuidFromSlug(params.slugAndId) : undefined;
  const { isAnonymous } = useShareContext();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id;

  const { data: pages, isLoading: isPagesLoading, error: pagesError } = usePageTree();
  const { data: folders, isLoading: isFoldersLoading, error: foldersError } = useFolderTree();
  const { data: favorites } = useFavorites();
  const { data: recentPages } = useRecentPages(SIDEBAR_PREVIEW_LIMIT);
  const { data: sharedNavigation } = useSharedWithMeTree(SIDEBAR_PREVIEW_LIMIT + 1);

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
  const [ownedByMeCollapsed, setOwnedByMeCollapsed] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget>(null);
  const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);

  const handleCreateRootPage = useCallback(async () => {
    try {
      const newPage = await createPageMutation.mutateAsync({});
      navigate(buildPagePath(newPage.title, newPage.id));
      setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [navigate, createPageMutation]);

  const handleCreateRootFolder = useCallback(async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({});
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        next.add(folder.id);
        return next;
      });
      setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [createFolderMutation]);

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
  const sidebarFolderIds = useMemo(
    () => Array.from(new Set([...allFolderIds, ...sharedNavigationFolderIds])),
    [allFolderIds, sharedNavigationFolderIds],
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
      { id: pageId, type: 'page', ownerId: page?.ownerId, createdBy: page?.createdBy },
      { force: false },
    );
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
      { id: folderId, type: 'folder', ownerId: folder?.ownerId, createdBy: folder?.createdBy },
      { force: hasChildren },
    );
  };

  const beginRenameFolder = (folder: FolderTreeNode) => {
    setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
  };

  const beginRenamePage = (page: PageTreeNode) => {
    setEditingTarget({ kind: 'page', id: page.id, value: page.title });
  };

  const saveRename = () => {
    if (!editingTarget) {
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
    const isEditingFolder = editingTarget?.kind === 'folder' && editingTarget.id === folder.id;

    return (
      <div key={`folder-${folder.id}`}>
        <PageTreeRow
          id={folder.id}
          title={folder.name}
          icon={folder.icon}
          ownerId={folder.ownerId}
          createdBy={folder.createdBy}
          depth={depth}
          hasChildren={childFolders.length > 0 || childPages.length > 0}
          isExpanded={isExpanded}
          onToggleExpand={() => toggleFolderExpanded(folder.id)}
          {...(folder.userPermission === 'edit' || folder.userPermission === 'admin'
            ? { onCreateChild: () => handleCreatePageInFolder(folder.id) }
            : {})}
          onDelete={() => handleDeleteFolder(folder.id, childFolders.length, childPages.length)}
          onRename={() => beginRenameFolder(folder)}
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
              const isEditingPage = editingTarget?.kind === 'page' && editingTarget.id === page.id;
              return (
                <PageTreeRow
                  key={page.id}
                  id={page.id}
                  title={page.title}
                  icon={page.icon}
                  ownerId={page.ownerId}
                  createdBy={page.createdBy}
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

  const renderSharedNavigationItem = (item: SharedNavigationItem, depth = 0): ReactNode => {
    if (item.entityType === 'folder') {
      const isExpanded = expandedFolderIds.has(item.id);
      const sourceFolder = folderById.get(item.id);
      const canCreateChild = item.userPermission === 'edit' || item.userPermission === 'admin';
      return (
        <div key={`shared-folder-${item.id}`}>
          <PageTreeRow
            id={item.id}
            title={item.title}
            icon={item.icon}
            ownerId={item.ownerId}
            createdBy={item.createdBy}
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
              });
            }}
            onRename={sourceFolder ? () => beginRenameFolder(sourceFolder) : undefined}
            onNavigate={() => navigate(buildFolderPath(item.title, item.id))}
            isFolder={true}
          />
          {isExpanded && item.children.map((child) => renderSharedNavigationItem(child, depth + 1))}
        </div>
      );
    }

    const sourcePage = pageById.get(item.id);
    return (
      <PageTreeRow
        key={`shared-page-${item.id}`}
        id={item.id}
        title={item.title}
        icon={item.icon}
        ownerId={item.ownerId}
        createdBy={item.createdBy}
        depth={depth}
        isActive={activePageId === item.id}
        isFavorite={isFavoriteEntity('page', item.id)}
        onDelete={() => {
          void pageDeletion.handleDelete({
            id: item.id,
            type: 'page',
            ownerId: item.ownerId,
            createdBy: item.createdBy,
          });
        }}
        onRename={sourcePage ? () => beginRenamePage(sourcePage) : undefined}
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

  if (pagesError || foldersError) {
    return (
      <div className="m-4 p-3 text-sm text-red-500 bg-zinc-100 dark:bg-zinc-800/50 rounded-md border border-red-200 dark:border-red-900/30">
        Failed to load notes
      </div>
    );
  }

  const rootFolders = ownedFolders;
  const sharedPreview = sharedNavigation?.slice(0, SIDEBAR_PREVIEW_LIMIT) ?? [];
  const hasMoreShared = (sharedNavigation?.length ?? 0) > SIDEBAR_PREVIEW_LIMIT;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        <div className="flex items-center justify-center gap-1 mb-2">
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
                  const childFolders = favFolder?.children.length ?? 0;
                  const childPages = pagesByFolder.get(fav.entityId)?.length ?? 0;
                  return (
                    <PageTreeRow
                      key={`${fav.entityType}-${fav.entityId}`}
                      id={fav.entityId}
                      title={fav.title}
                      icon={fav.icon}
                      ownerId={fav.ownerId ?? favPage?.ownerId ?? favFolder?.ownerId ?? null}
                      createdBy={favPage?.createdBy ?? favFolder?.createdBy ?? null}
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
                  return (
                    <PageTreeRow
                      key={page.id}
                      id={page.id}
                      title={page.title}
                      icon={page.icon}
                      ownerId={page.ownerId}
                      createdBy={page.createdBy}
                      isActive={activePageId === page.id}
                      isFavorite={isFavoriteEntity('page', page.id)}
                      onDelete={() => handleDeletePage(page.id)}
                      onRename={treePage ? () => beginRenamePage(treePage) : undefined}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {sharedPreview.length > 0 && (
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
              <div className="space-y-0.5">
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
                  editingTarget?.kind === 'page' && editingTarget.id === page.id;
                return (
                  <PageTreeRow
                    key={page.id}
                    id={page.id}
                    title={page.title}
                    icon={page.icon}
                    ownerId={page.ownerId}
                    createdBy={page.createdBy}
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
