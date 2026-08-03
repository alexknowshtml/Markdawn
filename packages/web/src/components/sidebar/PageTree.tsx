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
import { useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useEntityCommands } from '../../contexts/EntityCommandContext';
import { useIdentityLifecycle, useIdentityNavigate } from '../../contexts/IdentityLifecycleContext';
import { useShareContext } from '../../contexts/ShareContext';
import { useIsBulkRemovalPending } from '../../hooks/use-bulk-actions';
import { useFavorites } from '../../hooks/use-favorites';
import { useFolderTree, useUpdateFolder } from '../../hooks/use-folders';
import {
  useImportMarkdown,
  usePageTree,
  useRecentPages,
  useUpdatePage,
} from '../../hooks/use-pages';
import { useSharedWithMeTree } from '../../hooks/use-shared-with-me';
import { useOrgsMine } from '../../hooks/use-orgs';
import { useOrgPicker } from '../../hooks/use-org-picker';
import { useLeaveWorkspace, useWorkspaceMemberships } from '../../hooks/use-workspace';
import { OrgPicker } from './OrgPicker';
import { buildOrgColorMap } from '../../utils/orgColors';
import { useAuth } from '../../hooks/useAuth';
import { useEntityCreationActions } from '../../hooks/useEntityCreationActions';
import { useStableValueWhile } from '../../hooks/useStableValue';
import { showErrorToast } from '../../utils/toast';
import { buildPagePath, extractUuidFromSlug } from '../../utils/url';
import { SidebarEntityRow } from './SidebarEntityRow';
import { SidebarAliasSection } from './SidebarSections';
import {
  OwnedFolderBranch,
  SharedNavigationBranch,
  WorkspaceFolderBranch,
  WorkspacePageRow,
} from './SidebarTreeBranches';
import type { SidebarTreeRuntime } from './sidebarRuntime';
import { useSidebarController } from './useSidebarController';
import { useSidebarEditing } from './useSidebarEditing';
import { useSidebarModel } from './useSidebarModel';

const SIDEBAR_PREVIEW_LIMIT = 8;

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
  const { data: orgsMine } = useOrgsMine();
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

  const orgWorkspaces = useMemo(
    () => orgsMine?.flatMap((org) => org.workspaces) ?? [],
    [orgsMine],
  );

  const orgIds = useMemo(() => orgsMine?.map((o) => o.id) ?? [], [orgsMine]);
  const orgColorMap = useMemo(() => buildOrgColorMap(orgIds), [orgIds]);
  const wsToOrgMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const org of orgsMine ?? []) {
      for (const ws of org.workspaces) map.set(ws.id, org.id);
    }
    return map;
  }, [orgsMine]);

  const { selectedOrg, setSelectedOrg } = useOrgPicker(orgIds);
  const showOrgPicker = (orgsMine?.length ?? 0) > 1;

  const favoriteKeys = useMemo(
    () => new Set(favorites?.map((fav) => `${fav.entityType}:${fav.entityId}`) ?? []),
    [favorites],
  );
  const isFavoriteEntity = useCallback(
    (entityType: 'folder' | 'page', entityId: string) =>
      favoriteKeys.has(`${entityType}:${entityId}`),
    [favoriteKeys],
  );

  const { createPageAndNavigate, createFolder } = useEntityCreationActions();
  const entityCommands = useEntityCommands();
  const updatePageMutation = useUpdatePage();
  const updateFolderMutation = useUpdateFolder();
  const importMarkdownMutation = useImportMarkdown();
  const renamePage = useCallback(
    (pageId: string, title: string, onSettled: () => void) => {
      updatePageMutation.mutate({ pageId, updates: { title } }, { onSettled });
    },
    [updatePageMutation],
  );
  const renameFolder = useCallback(
    (folderId: string, name: string, onSettled: () => void) => {
      updateFolderMutation.mutate({ folderId, updates: { name } }, { onSettled });
    },
    [updateFolderMutation],
  );
  const {
    allPagesByFolder,
    canRenameSidebarEntity,
    directSharedNavigation,
    favoriteRows,
    foldersByParent,
    getSidebarAuthorization,
    getSidebarCapabilities,
    ownedWorkspaceGroups,
    pagesByFolder,
    recentRows,
    sidebarFolderIds,
    workspaceGroups,
  } = useSidebarModel({
    currentUserId,
    pages: pages ?? [],
    folders: folders ?? [],
    favorites: favorites ?? [],
    recentPages: recentPages ?? [],
    sharedNavigation: sharedNavigation ?? [],
    workspaceMemberships: workspaceMemberships ?? [],
    orgWorkspaces,
    selectedOrgId: selectedOrg,
    wsToOrgMap,
  });

  const {
    target: editingTarget,
    setTarget: setEditingTarget,
    save: saveRename,
    onKeyDown: onRenameKeyDown,
  } = useSidebarEditing({
    canRenameEntity: canRenameSidebarEntity,
    renamePage,
    renameFolder,
  });

  const sidebar = useSidebarController(sidebarFolderIds);

  const handleCreateRootPage = useCallback(async () => {
    try {
      const newPage = await createPageAndNavigate();
      if (!newPage) return;
      setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [createPageAndNavigate, setEditingTarget]);

  const handleCreateRootFolder = useCallback(async () => {
    try {
      const folder = await createFolder();
      if (!folder) return;
      sidebar.expandFolder(folder.id);
      setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
  }, [createFolder, setEditingTarget, sidebar.expandFolder]);

  useEffect(() => {
    return entityCommands.register({
      createNote: () => void handleCreateRootPage(),
      createFolder: () => void handleCreateRootFolder(),
    });
  }, [entityCommands, handleCreateRootPage, handleCreateRootFolder]);

  const handleCreatePageInFolder = useCallback(
    async (folderId: string) => {
      try {
        const newPage = await createPageAndNavigate({ parentId: folderId });
        if (!newPage) return;
        sidebar.expandFolder(folderId);
        setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
      } catch {
        // Error toast handled globally by MutationCache.onError
      }
    },
    [createPageAndNavigate, setEditingTarget, sidebar.expandFolder],
  );

  const handleImportMarkdown = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.md')) {
      showErrorToast('Please select a markdown file (.md)');
      event.target.value = '';
      return;
    }

    try {
      const { page: newPage } = await importMarkdownMutation.mutateAsync({ file });
      if (!identityLifecycle.isActive()) return;
      navigate(buildPagePath(newPage.title, newPage.id));
    } catch {
      // Error toast handled globally by MutationCache.onError
    }
    event.target.value = '';
  };

  const sidebarTreeRuntime = useMemo<SidebarTreeRuntime>(
    () => ({
      activePageId,
      expandedFolderIds: sidebar.expandedFolderIds,
      editingTarget,
      getAuthorization: getSidebarAuthorization,
      getCapabilities: getSidebarCapabilities,
      isFavoriteEntity,
      toggleFolderExpanded: sidebar.toggleFolder,
      createPageInFolder: handleCreatePageInFolder,
      startEditing: (kind, id, value) => setEditingTarget({ kind, id, value }),
      setEditingValue: (kind, id, value) => setEditingTarget({ kind, id, value }),
      saveRename,
      onRenameKeyDown,
    }),
    [
      activePageId,
      editingTarget,
      getSidebarAuthorization,
      getSidebarCapabilities,
      handleCreatePageInFolder,
      isFavoriteEntity,
      onRenameKeyDown,
      saveRename,
      setEditingTarget,
      sidebar.expandedFolderIds,
      sidebar.toggleFolder,
    ],
  );

  const { orgSections, ungroupedOwned, ungroupedShared } = useMemo(() => {
    type OwnedGroup = (typeof ownedWorkspaceGroups)[number];
    type SharedGroup = (typeof workspaceGroups)[number];
    const map = new Map<string, { orgId: string; orgName: string; owned: OwnedGroup[]; shared: SharedGroup[] }>();
    const ungroupedOwndArr: OwnedGroup[] = [];
    const ungroupedSharedArr: SharedGroup[] = [];
    for (const group of ownedWorkspaceGroups) {
      const orgId = group.workspaceId ? wsToOrgMap.get(group.workspaceId) : undefined;
      if (!orgId) { ungroupedOwndArr.push(group); continue; }
      const org = orgsMine?.find((o) => o.id === orgId);
      if (!map.has(orgId)) map.set(orgId, { orgId, orgName: org?.name ?? orgId, owned: [], shared: [] });
      map.get(orgId)!.owned.push(group);
    }
    for (const group of workspaceGroups) {
      if (!group.orgId) { ungroupedSharedArr.push(group); continue; }
      const org = orgsMine?.find((o) => o.id === group.orgId);
      if (!map.has(group.orgId)) map.set(group.orgId, { orgId: group.orgId, orgName: org?.name ?? group.orgId, owned: [], shared: [] });
      map.get(group.orgId)!.shared.push(group);
    }
    return { orgSections: [...map.values()], ungroupedOwned: ungroupedOwndArr, ungroupedShared: ungroupedSharedArr };
  }, [ownedWorkspaceGroups, workspaceGroups, wsToOrgMap, orgsMine]);

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

  const sharedPreview = directSharedNavigation.slice(0, SIDEBAR_PREVIEW_LIMIT);
  const hasMoreShared = directSharedNavigation.length > SIDEBAR_PREVIEW_LIMIT;

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-2 pt-2 pb-1">
        {showOrgPicker && (
          <div className="mb-2">
            <OrgPicker
              orgs={orgsMine ?? []}
              selectedOrg={selectedOrg}
              orgColorMap={orgColorMap}
              onSelect={setSelectedOrg}
            />
          </div>
        )}
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
            onClick={sidebar.toggleAll}
            className="p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-lg transition-all text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
            title={sidebar.allExpanded ? 'Collapse all folders' : 'Expand all folders'}
            data-testid="toggle-expand-all-btn"
          >
            {sidebar.allExpanded ? <ChevronsUp size={16} /> : <ChevronsDown size={16} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        <SidebarAliasSection
          title="Favorites"
          collapsed={sidebar.collapsedSections.has('favorites')}
          onToggle={() => sidebar.toggleSection('favorites')}
          rows={favoriteRows}
          runtime={sidebarTreeRuntime}
        />
        <SidebarAliasSection
          title="Recents"
          collapsed={sidebar.collapsedSections.has('recents')}
          onToggle={() => sidebar.toggleSection('recents')}
          rows={recentRows}
          runtime={sidebarTreeRuntime}
        />

        {orgSections.map(({ orgId, orgName, owned, shared }) => {
          const orgKey = `org-${orgId}`;
          const isOrgCollapsed = sidebar.collapsedSections.has(orgKey);
          const color = orgColorMap.get(orgId);
          return (
            <div key={orgKey}>
              <button
                type="button"
                onClick={() => sidebar.toggleSection(orgKey)}
                aria-expanded={!isOrgCollapsed}
                className={`flex items-center w-full px-2 py-1 mb-1 text-[11px] font-bold uppercase tracking-wider cursor-pointer transition-colors text-left rounded-md ${
                  color
                    ? `${color.headerBg} ${color.headerText} hover:opacity-90`
                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
                }`}
              >
                {isOrgCollapsed ? (
                  <ChevronRight size={14} className="mr-1 shrink-0" />
                ) : (
                  <ChevronDown size={14} className="mr-1 shrink-0" />
                )}
                <span className="truncate">{orgName}</span>
              </button>
              {!isOrgCollapsed && (
                <div className="space-y-0.5">
                  {owned.map((ownedGroup) => {
                    const wsKey = `owned-ws-${ownedGroup.workspaceId ?? 'default'}`;
                    const isWsCollapsed = sidebar.collapsedSections.has(wsKey);
                    const showOwnedHeader = owned.length > 1;
                    return (
                      <div key={wsKey}>
                        {showOwnedHeader && (
                          <button
                            type="button"
                            onClick={() => sidebar.toggleSection(wsKey)}
                            className="flex items-center w-full px-1 py-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                          >
                            {isWsCollapsed ? (
                              <ChevronRight size={12} className="mr-1 shrink-0" />
                            ) : (
                              <ChevronDown size={12} className="mr-1 shrink-0" />
                            )}
                            <span className="truncate">{ownedGroup.name}</span>
                          </button>
                        )}
                        {(!showOwnedHeader || !isWsCollapsed) && (
                          <div className="space-y-0.5">
                            {ownedGroup.folders.map((folder) => (
                              <OwnedFolderBranch
                                runtime={sidebarTreeRuntime}
                                key={folder.id}
                                folder={folder}
                                foldersByParent={foldersByParent}
                                pagesByFolder={pagesByFolder}
                              />
                            ))}
                            {ownedGroup.pages.map((page) => (
                              <SidebarEntityRow
                                runtime={sidebarTreeRuntime}
                                key={page.id}
                                entity={{
                                  entityType: 'page',
                                  id: page.id,
                                  title: page.title,
                                  icon: page.icon,
                                  ownerId: page.ownerId,
                                  createdBy: page.createdBy,
                                  userPermission: page.userPermission,
                                  parentId: page.parentId,
                                }}
                                placement="owned"
                              />
                            ))}
                            {ownedGroup.folders.length === 0 && ownedGroup.pages.length === 0 && (
                              <div className="pl-6 pr-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                                No notes yet
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {owned.length > 0 && shared.length > 0 && (
                    <div className="border-t border-zinc-200/70 dark:border-zinc-700/40 mx-1 mt-1.5 mb-1" />
                  )}
                  {shared.map((sharedGroup) => {
                    const isWsCollapsed = sidebar.collapsedWorkspaceIds.has(sharedGroup.ownerId);
                    return (
                      <div key={`shared-ws-${sharedGroup.ownerId}`} className="ml-5">
                        <div className="flex items-center">
                          <button
                            type="button"
                            onClick={() => sidebar.toggleWorkspace(sharedGroup.ownerId)}
                            className="flex min-w-0 flex-1 items-center text-xs font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer px-1 py-0.5 italic"
                          >
                            {isWsCollapsed ? (
                              <ChevronRight size={12} className="mr-1 shrink-0" />
                            ) : (
                              <ChevronDown size={12} className="mr-1 shrink-0" />
                            )}
                            <span className="truncate">{sharedGroup.ownerName ?? 'Shared'}</span>
                            <span className="ml-1.5 shrink-0 text-[10px] text-zinc-300 dark:text-zinc-600 not-italic">· shared</span>
                          </button>
                          <button
                            type="button"
                            title="Leave workspace"
                            aria-label={`Leave ${sharedGroup.ownerName ?? 'workspace'}`}
                            disabled={leaveWorkspaceMutation.isPending || !currentUserId}
                            onClick={() => {
                              if (!currentUserId) return;
                              leaveWorkspaceMutation.mutate({
                                ownerId: sharedGroup.ownerId,
                                memberId: currentUserId,
                              });
                            }}
                            className="rounded p-1 text-zinc-300 dark:text-zinc-600 hover:bg-black/5 hover:text-red-600 disabled:opacity-40 dark:hover:bg-white/10 cursor-pointer shrink-0"
                          >
                            <LogOut size={12} />
                          </button>
                        </div>
                        {!isWsCollapsed && (
                          <div className="space-y-0.5">
                            {sharedGroup.folders.map((folder) => (
                              <WorkspaceFolderBranch
                                runtime={sidebarTreeRuntime}
                                key={folder.id}
                                folder={folder}
                                workspaceOwnerId={sharedGroup.ownerId}
                                allPagesByFolder={allPagesByFolder}
                                sourceIsAdmin={sharedGroup.role === 'admin'}
                              />
                            ))}
                            {sharedGroup.pages.map((page) => (
                              <WorkspacePageRow
                                runtime={sidebarTreeRuntime}
                                key={page.id}
                                page={page}
                                sourceIsAdmin={sharedGroup.role === 'admin'}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {ungroupedOwned.map((group) => {
          const sectionKey = `owned-ws-${group.workspaceId ?? 'default'}`;
          const isCollapsed = sidebar.collapsedSections.has(sectionKey);
          return (
            <div key={sectionKey}>
              <button
                type="button"
                onClick={() => sidebar.toggleSection(sectionKey)}
                className="flex items-center w-full px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors text-left"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="mr-1 shrink-0" />
                ) : (
                  <ChevronDown size={14} className="mr-1 shrink-0" />
                )}
                <span className="truncate">{group.name}</span>
              </button>
              {!isCollapsed && (
                <div className="space-y-0.5">
                  {group.folders.map((folder) => (
                    <OwnedFolderBranch
                      runtime={sidebarTreeRuntime}
                      key={folder.id}
                      folder={folder}
                      foldersByParent={foldersByParent}
                      pagesByFolder={pagesByFolder}
                    />
                  ))}
                  {group.pages.map((page) => (
                    <SidebarEntityRow
                      runtime={sidebarTreeRuntime}
                      key={page.id}
                      entity={{
                        entityType: 'page',
                        id: page.id,
                        title: page.title,
                        icon: page.icon,
                        ownerId: page.ownerId,
                        createdBy: page.createdBy,
                        userPermission: page.userPermission,
                        parentId: page.parentId,
                      }}
                      placement="owned"
                    />
                  ))}
                  {group.folders.length === 0 && group.pages.length === 0 && (
                    <div className="pl-6 pr-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                      No notes yet
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {(ungroupedShared.length > 0 || sharedPreview.length > 0) && (
          <div className="space-y-1">
            {ungroupedShared.map((group) => {
              const isCollapsed = sidebar.collapsedWorkspaceIds.has(group.ownerId);
              return (
                <div key={`workspace-${group.ownerId}`}>
                  <div className="flex items-center gap-1 mb-1">
                    <button
                      type="button"
                      onClick={() => sidebar.toggleWorkspace(group.ownerId)}
                      className="flex min-w-0 flex-1 items-center text-left text-[11px] font-bold uppercase tracking-wider cursor-pointer transition-colors rounded-md px-2 py-1 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
                    >
                      {isCollapsed ? (
                        <ChevronRight size={13} className="mr-1 shrink-0" />
                      ) : (
                        <ChevronDown size={13} className="mr-1 shrink-0" />
                      )}
                      <span className="truncate">
                        {group.ownerName ? `${group.ownerName}'s Workspace` : 'Shared Workspace'}
                      </span>
                    </button>
                    <button
                      type="button"
                      title="Leave workspace"
                      aria-label={`Leave ${group.ownerName ?? 'workspace'}`}
                      disabled={leaveWorkspaceMutation.isPending || !currentUserId}
                      onClick={() => {
                        if (!currentUserId) return;
                        leaveWorkspaceMutation.mutate({ ownerId: group.ownerId, memberId: currentUserId });
                      }}
                      className="rounded p-1 text-zinc-400 hover:bg-black/5 hover:text-red-600 disabled:opacity-40 dark:hover:bg-white/10 cursor-pointer shrink-0"
                    >
                      <LogOut size={12} />
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="space-y-0.5">
                      {group.folders.map((folder) => (
                        <WorkspaceFolderBranch
                          runtime={sidebarTreeRuntime}
                          key={folder.id}
                          folder={folder}
                          workspaceOwnerId={group.ownerId}
                          allPagesByFolder={allPagesByFolder}
                          sourceIsAdmin={group.role === 'admin'}
                        />
                      ))}
                      {group.pages.map((page) => (
                        <WorkspacePageRow
                          runtime={sidebarTreeRuntime}
                          key={page.id}
                          page={page}
                          sourceIsAdmin={group.role === 'admin'}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {sharedPreview.map((item) => (
              <SharedNavigationBranch
                key={`${item.entityType}-${item.id}`}
                item={item}
                runtime={sidebarTreeRuntime}
              />
            ))}
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

        {orgSections.length === 0 && ungroupedOwned.length === 0 && ungroupedShared.length === 0 && sharedPreview.length === 0 && (
          <div className="px-1 py-2 text-sm text-zinc-500 dark:text-zinc-400">
            No notes yet
          </div>
        )}
      </div>
    </div>
  );
}
