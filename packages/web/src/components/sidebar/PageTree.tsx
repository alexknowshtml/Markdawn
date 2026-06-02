import type { FolderTreeNode, PageTreeNode } from '@markdawn/shared';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useShareContext } from '../../contexts/ShareContext';
import { useFavorites, useToggleFavorite } from '../../hooks/use-favorites';
import {
  useCreateFolder,
  useDeleteFolder,
  useFolderTree,
  useUpdateFolder,
} from '../../hooks/use-folders';
import {
  useCreatePage,
  useDeletePage,
  useImportMarkdown,
  useLeavePage,
  usePageTree,
  useUpdatePage,
} from '../../hooks/use-pages';
import { useAuth } from '../../hooks/useAuth';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { buildPagePath, extractUuidFromSlug } from '../../utils/url';
import { markSelfLeave } from '../../utils/leave-page';
import { PublicShareDialog } from '../editor/PublicShareDialog';
import { PageTreeRow } from './PageTreeRow';

type EditingTarget =
  | { kind: 'page'; id: string; value: string }
  | { kind: 'folder'; id: string; value: string }
  | null;

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

  const favoritePageIds = useMemo(
    () => new Set(favorites?.map((fav) => fav.pageId) ?? []),
    [favorites],
  );

  const createPageMutation = useCreatePage();
  const updatePageMutation = useUpdatePage();
  const deletePageMutation = useDeletePage();
  const leavePageMutation = useLeavePage();
  const createFolderMutation = useCreateFolder();
  const updateFolderMutation = useUpdateFolder();
  const deleteFolderMutation = useDeleteFolder();
  const toggleFavoriteMutation = useToggleFavorite();
  const importMarkdownMutation = useImportMarkdown();

  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
  const [allPagesCollapsed, setAllPagesCollapsed] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget>(null);
  const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);
  const [shareTarget, setShareTarget] = useState<{
    type: 'page' | 'folder';
    id: string;
    title: string;
  } | null>(null);
  const [shareAnchorRect, setShareAnchorRect] = useState<DOMRect | null>(null);

  const openShare = (
    target: {
      type: 'page' | 'folder';
      id: string;
      title: string;
    },
    anchorRect: DOMRect,
  ) => {
    setShareTarget(target);
    setShareAnchorRect(anchorRect);
  };

  const handleCreateRootPage = useCallback(async () => {
    try {
      const newPage = await createPageMutation.mutateAsync({});
      navigate(buildPagePath(newPage.title, newPage.id));
      setEditingTarget({ kind: 'page', id: newPage.id, value: newPage.title ?? 'Untitled' });
    } catch {
      showErrorToast('Failed to create note');
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
      showErrorToast('Failed to create folder');
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

  const pagesByFolder = useMemo(() => {
    const map = new Map<string | null, PageTreeNode[]>();
    for (const page of pages ?? []) {
      const key = page.parentId ?? null;
      const list = map.get(key) ?? [];
      list.push(page);
      map.set(key, list);
    }
    return map;
  }, [pages]);

  const folderIdsSet = useMemo(
    () => new Set((folders ?? []).map((folder) => folder.id)),
    [folders],
  );

  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, FolderTreeNode[]>();
    const walk = (nodes: FolderTreeNode[]) => {
      for (const folder of nodes) {
        const key = folder.parentId ?? null;
        const list = map.get(key) ?? [];
        list.push(folder);
        map.set(key, list);
        if (folder.children && folder.children.length > 0) {
          walk(folder.children);
        }
      }
    };
    walk(folders ?? []);
    return map;
  }, [folders]);

  const allFolderIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: FolderTreeNode[]) => {
      for (const folder of nodes) {
        ids.push(folder.id);
        if (folder.children && folder.children.length > 0) {
          walk(folder.children);
        }
      }
    };
    walk(folders ?? []);
    return ids;
  }, [folders]);

  useEffect(() => {
    if (!hasInitializedExpansion && (folders?.length ?? 0) > 0) {
      setExpandedFolderIds(new Set(allFolderIds));
      setHasInitializedExpansion(true);
    }
  }, [folders, allFolderIds, hasInitializedExpansion]);

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
    allFolderIds.length > 0 && allFolderIds.every((id) => expandedFolderIds.has(id));

  const toggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedFolderIds(new Set());
      setFavoritesCollapsed(true);
      setAllPagesCollapsed(true);
    } else {
      setExpandedFolderIds(new Set(allFolderIds));
      setFavoritesCollapsed(false);
      setAllPagesCollapsed(false);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create note';
      showErrorToast(message);
    }
  };

  const handleDeletePage = async (pageId: string) => {
    const page = pages?.find((p) => p.id === pageId);
    const isOwnPage = page?.createdBy === currentUserId;
    if (isOwnPage) {
      await deletePageMutation.mutateAsync(pageId);
    } else {
      markSelfLeave(pageId);
      await leavePageMutation.mutateAsync(pageId);
    }
    if (activePageId === pageId) {
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
      showErrorToast('Failed to import note');
    }
    event.target.value = '';
  };

  const handleDeleteFolder = async (folderId: string, childFolders: number, childPages: number) => {
    await deleteFolderMutation.mutateAsync({
      folderId,
      force: childFolders > 0 || childPages > 0,
    });
  };

  const handleToggleFavorite = async (pageId: string, isCurrentlyFavorite: boolean) => {
    await toggleFavoriteMutation.mutateAsync({
      pageId,
      isFavorite: isCurrentlyFavorite,
    });
  };

  const handleExport = async (pageId: string, title: string) => {
    try {
      const res = await fetch(`/api/pages/${pageId}/export/markdown`);
      if (!res.ok) throw new Error('Failed to export');
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition');
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? `${title || 'page'}.md`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccessToast('Exported to markdown');
    } catch {
      showErrorToast('Failed to export note');
    }
  };

  const beginRenameFolder = (folder: FolderTreeNode) => {
    setEditingTarget({ kind: 'folder', id: folder.id, value: folder.name });
  };

  const beginRenamePage = (page: PageTreeNode) => {
    setEditingTarget({ kind: 'page', id: page.id, value: page.title });
  };

  const saveRename = async () => {
    if (!editingTarget) {
      return;
    }
    const trimmed = editingTarget.value.trim();

    if (editingTarget.kind === 'folder') {
      const finalName = trimmed.length > 0 ? trimmed : 'New Folder';
      try {
        await updateFolderMutation.mutateAsync({
          folderId: editingTarget.id,
          updates: { name: finalName },
        });
      } catch {
        showErrorToast('Failed to rename folder');
      }
      setEditingTarget(null);
      return;
    }

    const finalTitle = trimmed.length > 0 ? trimmed : 'Untitled';
    try {
      await updatePageMutation.mutateAsync({
        pageId: editingTarget.id,
        updates: { title: finalTitle },
      });
    } catch {
      showErrorToast('Failed to rename note');
    }
    setEditingTarget(null);
  };

  const onRenameKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      void saveRename();
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
          depth={depth}
          hasChildren={childFolders.length > 0 || childPages.length > 0}
          isExpanded={isExpanded}
          onToggleExpand={() => toggleFolderExpanded(folder.id)}
          onCreateChild={() => handleCreatePageInFolder(folder.id)}
          onDelete={() => handleDeleteFolder(folder.id, childFolders.length, childPages.length)}
          onRename={() => beginRenameFolder(folder)}
          onShare={(anchorRect) =>
            openShare({ type: 'folder', id: folder.id, title: folder.name }, anchorRect)
          }
          onNavigate={() => toggleFolderExpanded(folder.id)}
          isEditing={isEditingFolder}
          isFolder={true}
          editTitle={isEditingFolder ? editingTarget.value : folder.name}
          onEditChange={(value) => setEditingTarget({ kind: 'folder', id: folder.id, value })}
          onEditSave={() => {
            void saveRename();
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
                  depth={depth + 1}
                  isActive={activePageId === page.id}
                  isFavorite={favoritePageIds.has(page.id)}
                  onToggleFavorite={() =>
                    handleToggleFavorite(page.id, favoritePageIds.has(page.id))
                  }
                  onDelete={() => handleDeletePage(page.id)}
                  onRename={() => beginRenamePage(page)}
                  onExport={() => handleExport(page.id, page.title)}
                  onShare={(anchorRect) =>
                    openShare({ type: 'page', id: page.id, title: page.title }, anchorRect)
                  }
                  isEditing={isEditingPage}
                  editTitle={isEditingPage ? editingTarget.value : page.title}
                  onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
                  onEditSave={() => {
                    void saveRename();
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

  const rootFolders = foldersByParent.get(null) ?? [];
  const rootPages = pagesByFolder.get(null) ?? [];
  const orphanNestedPages = (pages ?? []).filter(
    (page) => page.parentId !== null && !folderIdsSet.has(page.parentId),
  );

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
              className="flex items-center px-4 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
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
                {favorites.map((fav) => (
                  <PageTreeRow
                    key={fav.pageId}
                    id={fav.pageId}
                    title={fav.title}
                    icon={fav.icon}
                    isActive={activePageId === fav.pageId}
                    isFavorite={true}
                    onToggleFavorite={() => handleToggleFavorite(fav.pageId, true)}
                    onDelete={() => handleDeletePage(fav.pageId)}
                    onExport={() => handleExport(fav.pageId, fav.title)}
                    onShare={(anchorRect) =>
                      openShare({ type: 'page', id: fav.pageId, title: fav.title }, anchorRect)
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setAllPagesCollapsed((prev) => !prev)}
            aria-expanded={!allPagesCollapsed}
            className="flex items-center px-4 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
          >
            {allPagesCollapsed ? (
              <ChevronRight size={14} className="mr-1 shrink-0" />
            ) : (
              <ChevronDown size={14} className="mr-1 shrink-0" />
            )}
            <span>All Pages</span>
          </button>
          {!allPagesCollapsed && (
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
                    isActive={activePageId === page.id}
                    isFavorite={favoritePageIds.has(page.id)}
                    onToggleFavorite={() =>
                      handleToggleFavorite(page.id, favoritePageIds.has(page.id))
                    }
                    onDelete={() => handleDeletePage(page.id)}
                    onRename={() => beginRenamePage(page)}
                    onExport={() => handleExport(page.id, page.title)}
                    onShare={(anchorRect) =>
                      openShare({ type: 'page', id: page.id, title: page.title }, anchorRect)
                    }
                    isEditing={isEditingPage}
                    editTitle={isEditingPage ? editingTarget.value : page.title}
                    onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
                    onEditSave={() => {
                      void saveRename();
                    }}
                    onEditKeyDown={onRenameKeyDown}
                  />
                );
              })}
              {orphanNestedPages.map((page) => {
                const isEditingPage =
                  editingTarget?.kind === 'page' && editingTarget.id === page.id;
                return (
                  <PageTreeRow
                    key={`orphan-${page.id}`}
                    id={page.id}
                    title={page.title}
                    icon={page.icon}
                    isActive={activePageId === page.id}
                    isFavorite={favoritePageIds.has(page.id)}
                    onToggleFavorite={() =>
                      handleToggleFavorite(page.id, favoritePageIds.has(page.id))
                    }
                    onDelete={() => handleDeletePage(page.id)}
                    onRename={() => beginRenamePage(page)}
                    onExport={() => handleExport(page.id, page.title)}
                    onShare={(anchorRect) =>
                      openShare({ type: 'page', id: page.id, title: page.title }, anchorRect)
                    }
                    isEditing={isEditingPage}
                    editTitle={isEditingPage ? editingTarget.value : page.title}
                    onEditChange={(value) => setEditingTarget({ kind: 'page', id: page.id, value })}
                    onEditSave={() => {
                      void saveRename();
                    }}
                    onEditKeyDown={onRenameKeyDown}
                  />
                );
              })}
              {rootFolders.length === 0 && rootPages.length === 0 && (
                <div className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
                  No notes yet
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {shareTarget && (
        <PublicShareDialog
          entityType={shareTarget.type}
          entityId={shareTarget.id}
          title={shareTarget.title}
          anchorRect={shareAnchorRect}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
