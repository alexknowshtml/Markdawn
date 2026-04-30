import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketStatus } from '@hocuspocus/provider';
import { MilkdownEditor } from '../components/editor/MilkdownEditor';
import { PageTitle } from '../components/editor/PageTitle';
import { PageIcon } from '../components/editor/PageIcon';
import { PageActions } from '../components/editor/PageActions';
import { Breadcrumbs } from '../components/editor/Breadcrumbs';
import { PageStatus } from '../components/editor/PageStatus';
import { TableOfContents } from '../components/editor/TableOfContents';
import { PropertiesPanel } from '../components/editor/PropertiesPanel';
import { BacklinksPanel } from '../components/editor/BacklinksPanel';
import { usePageTree } from '../hooks/use-pages';
import { useFolderTree } from '../hooks/use-folders';
import { useWorkspaces } from '../hooks/use-workspaces';
import type { Page as PageType, PageTreeNode, Folder, FolderTreeNode } from '@markdawn/shared';

const API_BASE = '/api';

async function fetchPage(pageId: string): Promise<PageType> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page');
  }
  return res.json();
}

function decodePageContent(ydoc: unknown): string {
  if (!ydoc || !Array.isArray(ydoc) || ydoc.length === 0) {
    return '';
  }
  const hasNullByte = ydoc.includes(0);
  if (!hasNullByte) {
    return new TextDecoder().decode(new Uint8Array(ydoc as number[]));
  }
  return '';
}

export default function Page() {
  const { pageId, workspaceSlug } = useParams<{ pageId: string; workspaceSlug: string }>();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [collabStatus, setCollabStatus] = useState<WebSocketStatus>(WebSocketStatus.Connecting);
  const editorElementRef = useRef<HTMLElement | null>(null);

  const handleStatusChange = (newStatus: WebSocketStatus) => {
    setCollabStatus(newStatus);
  };

  useEffect(() => {
    const findEditorElement = () => {
      const editorElement = document.querySelector('.milkdown-editor');
      if (editorElement) {
        editorElementRef.current = editorElement as HTMLElement;
      }
    };

    findEditorElement();
    const timeoutId = setTimeout(findEditorElement, 500);

    return () => clearTimeout(timeoutId);
  }, [pageId]);

  const { data: page } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => fetchPage(pageId!),
    enabled: !!pageId,
  });

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
  }, [page]);

  useEffect(() => {
    updateDocumentMeta();
  }, [updateDocumentMeta]);

  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const { data: pageTree } = usePageTree(workspaceId ?? '');
  const { data: folderTree } = useFolderTree(workspaceId ?? '');

  const flatPages = useMemo(() => {
    const result: PageType[] = [];
    const visit = (nodes: PageTreeNode[] | undefined) => {
      if (!nodes) return;
      nodes.forEach((node) => {
        result.push(node);
        if (node.children && node.children.length > 0) {
          visit(node.children);
        }
      });
    };
    visit(pageTree as PageTreeNode[] | undefined);
    return result;
  }, [pageTree]);

  const flatFolders = useMemo(() => {
    const result: Folder[] = [];
    const visit = (nodes: FolderTreeNode[] | undefined) => {
      if (!nodes) return;
      nodes.forEach((node) => {
        const { children, ...folder } = node as FolderTreeNode & { children?: FolderTreeNode[] };
        result.push(folder);
        if (children && children.length > 0) {
          visit(children);
        }
      });
    };
    visit(folderTree as FolderTreeNode[] | undefined);
    return result;
  }, [folderTree]);

  const handleWikiLinkClick = useCallback((path: string) => {
    if (!path || !workspaceSlug) return;
    const targetPage = flatPages.find(
      (p) => p.title.toLowerCase() === path.toLowerCase()
    );
    if (targetPage) {
      navigate(`/app/${workspaceSlug}/${targetPage.id}`);
    }
  }, [workspaceSlug, flatPages]);

  if (!pageId || !workspaceSlug) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 text-zinc-400 animate-fade-in">
        Page not found.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm font-medium text-zinc-500 dark:text-zinc-400 -mt-5">
          <div>
            <Breadcrumbs
              pages={flatPages}
              folders={flatFolders}
              currentPageId={pageId}
              workspaceName={workspace?.name ?? workspaceSlug}
              workspaceSlug={workspaceSlug}
            />
          </div>
          <div className="flex items-center gap-2">
            <PageActions workspaceSlug={workspaceSlug} pageId={pageId} page={page} />
            <PageStatus provider={provider} collabStatus={collabStatus} />
          </div>
        </div>

        <div className="relative flex-1 flex items-center mt-19">
          <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center justify-center w-[42px] h-[42px]">
            <PageIcon pageId={pageId} initialIcon={page?.icon ?? null} />
          </div>
          <div className="pl-[54px] w-full">
            <PageTitle pageId={pageId} initialTitle={page?.title ?? 'Untitled'} />
          </div>
        </div>
      </div>
      <PropertiesPanel pageId={pageId} properties={page?.properties ?? null} />
      <MilkdownEditor
        key={pageId}
        pageId={pageId}
        workspaceId={workspaceId ?? ''}
        initialValue={decodePageContent(page?.ydoc)}
        onProviderReady={setProvider}
        onStatusChange={handleStatusChange}
        pages={flatPages}
        onWikiLinkClick={handleWikiLinkClick}
      />
      <BacklinksPanel pageId={pageId} workspaceSlug={workspaceSlug} />
      <TableOfContents editorElement={editorElementRef.current} />
    </div>
  );
}
