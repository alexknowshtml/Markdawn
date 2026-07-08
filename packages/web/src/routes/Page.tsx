import type { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketStatus } from '@hocuspocus/provider';
import {
  type CapabilitySet,
  deriveCapabilities,
  type Folder,
  type FolderTreeNode,
  type PageTreeNode,
  type Page as PageType,
  type SharePermission,
} from '@markdawn/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BacklinksPanel } from '../components/editor/BacklinksPanel';
import { Breadcrumbs } from '../components/editor/Breadcrumbs';
import { MilkdownEditor } from '../components/editor/MilkdownEditor';
import { PageActions } from '../components/editor/PageActions';
import { PageIcon } from '../components/editor/PageIcon';
import { PageStatus } from '../components/editor/PageStatus';
import { PageTitle } from '../components/editor/PageTitle';
import { PropertiesPanel } from '../components/editor/PropertiesPanel';
import { TableOfContents } from '../components/editor/TableOfContents';
import { ThemeToggle } from '../components/ThemeToggle';
import { EditorReadOnlyProvider } from '../contexts/EditorReadOnlyContext';
import {
  useSetCapabilities,
  useSetLinkPermission,
  useShareContext,
} from '../contexts/ShareContext';
import { useFolderTree } from '../hooks/use-folders';
import { type RecentPage, usePageTree } from '../hooks/use-pages';
import { ApiError } from '../utils/api';
import { buildPagePath, extractUuidFromSlug } from '../utils/url';

const API_BASE = '/api';

type PageDetail = PageType & {
  userPermission?: SharePermission | null;
  capabilities?: CapabilitySet;
  linkPermission?: 'view' | 'edit' | null;
};

async function fetchPage(pageId: string): Promise<PageDetail> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'Failed to fetch page';
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export default function Page() {
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const pageId = slugAndId ? extractUuidFromSlug(slugAndId) : undefined;
  const navigate = useNavigate();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [collabStatus, setCollabStatus] = useState<WebSocketStatus>(WebSocketStatus.Connecting);
  const accessRecordedRef = useRef<string | null>(null);
  const isFirstMount = useRef(true);
  const prevPageIdRef = useRef<string | undefined>(pageId);
  const queryClient = useQueryClient();
  const { isAnonymous, capabilities, linkPermission } = useShareContext();
  const setLinkPermission = useSetLinkPermission();
  const setCapabilities = useSetCapabilities();

  // Clear state on page navigation.
  // Skip when pageId transitions from undefined → UUID (initialization, not navigation)
  // and skip on the very first mount.
  useEffect(() => {
    const prevPageId = prevPageIdRef.current;

    if (isFirstMount.current) {
      isFirstMount.current = false;
      prevPageIdRef.current = pageId;
      return;
    }

    if (prevPageId === undefined && pageId !== undefined) {
      prevPageIdRef.current = pageId;
      return;
    }

    prevPageIdRef.current = pageId;
    // Don't reset provider here — MilkdownEditor manages its own lifecycle.
    // This effect runs AFTER MilkdownEditor's onProviderReady (child effects
    // fire first), so setProvider(null) would overwrite the new provider.
    setCollabStatus(WebSocketStatus.Connecting);
    setEditorElement(null);
  }, [pageId]);
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null);

  const { data: page, error } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchPage(pageId);
    },
    enabled: !!pageId,
    retry: false,
  });

  const pagePermission = page?.userPermission ?? linkPermission;
  const contextLinkPermission = pagePermission === 'admin' ? 'edit' : pagePermission;
  const effectiveCapabilities = useMemo(
    () => page?.capabilities ?? (page ? deriveCapabilities(pagePermission) : capabilities),
    [page, pagePermission, capabilities],
  );
  const readOnly = pagePermission === 'view';

  useEffect(() => {
    if (!page) return;
    setLinkPermission(contextLinkPermission);
    setCapabilities(effectiveCapabilities);
  }, [page, contextLinkPermission, effectiveCapabilities, setLinkPermission, setCapabilities]);

  // Find the .milkdown-editor DOM element for TableOfContents.
  // Re-runs on page change (data load or navigation) to handle the
  // editor mounting asynchronously after page fetch completes.
  // Polls up to 4 times (0ms, 200ms, 600ms, 1400ms) to catch the
  // editor regardless of page load timing.
  useEffect(() => {
    if (!page) return;
    let attempts = 0;
    const maxAttempts = 4;
    let id: ReturnType<typeof setTimeout>;

    const poll = () => {
      const el = document.querySelector('.milkdown-editor') as HTMLElement | null;
      if (el) {
        setEditorElement(el);
        return;
      }
      attempts++;
      if (attempts < maxAttempts) {
        id = setTimeout(poll, attempts * 200);
      }
    };
    poll();
    return () => clearTimeout(id);
  }, [page]);

  useEffect(() => {
    if (!page || !pageId || isAnonymous) {
      return;
    }
    if (accessRecordedRef.current === pageId) {
      return;
    }
    accessRecordedRef.current = pageId;

    const visitedAt = new Date().toISOString();
    queryClient.setQueriesData<RecentPage[]>({ queryKey: ['pages', 'recent'] }, (old) => {
      if (!old) return old;
      const next: RecentPage[] = [
        {
          id: page.id,
          title: page.title,
          icon: page.icon,
          createdBy: page.createdBy,
          ownerId: page.ownerId ?? null,
          updatedAt: page.updatedAt,
          visitedAt,
        },
        ...old.filter((recentPage) => recentPage.id !== page.id),
      ];
      return next.slice(0, old.length);
    });

    fetch(`/api/pages/${pageId}/access`, {
      method: 'POST',
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error('Failed to record page access');
        }
        const access = (await res.json()) as { recordedLinkAccess?: boolean };
        if (access.recordedLinkAccess) {
          queryClient.invalidateQueries({ queryKey: ['pageTree'] });
          queryClient.invalidateQueries({ queryKey: ['folderTree'] });
          queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
        }
        queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      })
      .catch(() => {
        void 0;
      });
  }, [page, pageId, isAnonymous, queryClient]);

  const handleStatusChange = (newStatus: WebSocketStatus) => {
    setCollabStatus(newStatus);
  };

  const updateDocumentMeta = useCallback(() => {
    if (!page) return;

    document.title = `${page.title} | Markdawn`;

    const existingLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const icon = page.icon;

    if (icon && icon.trim().length > 0) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">${icon}</text></svg>`;
      const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      if (existingLink) {
        existingLink.href = dataUrl;
      }
    } else if (existingLink) {
      existingLink.href = '/vite.svg';
    }

    let canonicalLink = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonicalLink) {
      canonicalLink = document.createElement('link');
      canonicalLink.rel = 'canonical';
      document.head.appendChild(canonicalLink);
    }
    canonicalLink.href = `${window.location.origin}${buildPagePath(page.title, page.id)}`;
  }, [page]);

  useEffect(() => {
    updateDocumentMeta();
  }, [updateDocumentMeta]);

  useEffect(() => {
    if (!page || !slugAndId) return;
    const expectedPath = buildPagePath(page.title, page.id).slice('/app/'.length);

    if (slugAndId !== expectedPath) {
      const newPath = window.location.pathname.replace(/\/[^/]+$/, `/${expectedPath}`);
      window.history.replaceState(null, '', newPath);
    }
  }, [page, slugAndId]);

  const { data: pageTree } = usePageTree();
  const { data: folderTree } = useFolderTree();

  const flatPages = useMemo(() => {
    if (isAnonymous) return [];
    const result: PageType[] = [];
    const visit = (nodes: PageTreeNode[] | undefined) => {
      if (!nodes) return;
      for (const node of nodes) {
        result.push(node);
        if (node.children && node.children.length > 0) {
          visit(node.children);
        }
      }
    };
    visit(pageTree as PageTreeNode[] | undefined);
    if (page && !result.some((item) => item.id === page.id)) {
      result.push(page);
    }
    return result;
  }, [pageTree, page, isAnonymous]);

  const flatFolders = useMemo(() => {
    if (isAnonymous) return [];
    const result: Folder[] = [];
    const visit = (nodes: FolderTreeNode[] | undefined) => {
      if (!nodes) return;
      for (const node of nodes) {
        const { children, ...folder } = node as FolderTreeNode & { children?: FolderTreeNode[] };
        result.push(folder);
        if (children && children.length > 0) {
          visit(children);
        }
      }
    };
    visit(folderTree as FolderTreeNode[] | undefined);
    return result;
  }, [folderTree, isAnonymous]);

  const handleWikiLinkClick = useCallback(
    (path: string) => {
      if (!path || isAnonymous) return;
      const targetPage = flatPages.find(
        (p) => p.id === path || p.title.toLowerCase() === path.toLowerCase(),
      );
      if (targetPage) {
        navigate(buildPagePath(targetPage.title, targetPage.id));
      }
    },
    [flatPages, navigate, isAnonymous],
  );

  if (!pageId) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 text-zinc-400 animate-fade-in">
        Page not found.
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 403) {
      return (
        <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 animate-fade-in">
          <div className="flex flex-col items-center gap-4 text-center py-16">
            <ShieldOff size={48} className="text-zinc-300 dark:text-zinc-600" />
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              You don&apos;t have access
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Your access to this page may have been removed. Contact the page owner to request
              access.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 text-zinc-400 animate-fade-in">
        Page not found.
      </div>
    );
  }

  if (!page) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-zinc-400 animate-fade-in">
        Loading page...
      </div>
    );
  }

  return (
    <EditorReadOnlyProvider readOnly={readOnly}>
      <div className="max-w-4xl mx-auto px-6 animate-fade-in">
        <div className="sticky top-0 z-10 -mx-6 px-6 py-2 bg-zinc-50 dark:bg-zinc-950 md:-mt-12">
          <div className="flex items-center justify-between text-sm font-medium text-zinc-500 dark:text-zinc-400 md:pt-5">
            {isAnonymous ? (
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
              >
                <LogIn size={14} />
                Sign in
              </button>
            ) : (
              <div>
                <Breadcrumbs pages={flatPages} folders={flatFolders} currentPageId={pageId} />
              </div>
            )}
            <div className="flex items-center gap-2">
              {!effectiveCapabilities.canEdit && (
                <span className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded-full">
                  View only
                </span>
              )}
              {!isAnonymous && <PageActions pageId={pageId} page={page} />}
              {isAnonymous && <ThemeToggle />}
              <PageStatus provider={provider} collabStatus={collabStatus} />
            </div>
          </div>
        </div>

        <div className="mb-6">
          <div className="relative flex-1 flex items-center mt-16">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center justify-center w-[42px] h-[42px]">
              <PageIcon pageId={pageId} initialIcon={page?.icon ?? null} />
            </div>
            <div className="pl-[54px] w-full">
              <PageTitle
                pageId={pageId}
                initialTitle={page?.title ?? 'Untitled'}
                ydoc={provider?.document ?? null}
              />
            </div>
          </div>
        </div>
        <PropertiesPanel pageId={pageId} properties={page?.properties ?? null} />
        {page && pageId ? (
          <MilkdownEditor
            key={pageId}
            pageId={pageId}
            onProviderReady={setProvider}
            onStatusChange={handleStatusChange}
            onWikiLinkClick={handleWikiLinkClick}
          />
        ) : null}
        {!isAnonymous && <BacklinksPanel pageId={pageId} />}
        <TableOfContents editorElement={editorElement} />
      </div>
    </EditorReadOnlyProvider>
  );
}
