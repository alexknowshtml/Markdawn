import React, { useState, useEffect, useMemo } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import { FileText, Star, MessageSquare, Share, Code2, List } from "lucide-react";
import { usePageTitle } from "../../hooks/usePageTitle";
import { usePageTree, useUpdatePage } from "../../hooks/use-pages";
import { useWorkspaces } from "../../hooks/use-workspaces";
import { useFavorites, useToggleFavorite } from "../../hooks/use-favorites";
import { CollabStatus } from "./CollabStatus";
import { EmojiPicker } from "../EmojiPicker";
import { Breadcrumbs } from "./Breadcrumbs";

import { Page, PageTreeNode } from "@markdawn/shared";
import { PublicShareDialog } from "./PublicShareDialog";
import { showErrorToast } from "../../utils/toast"

interface EditorHeaderProps {
  workspaceSlug: string;
  pageId: string;
  initialTitle: string;
  initialIcon: string | null;
  provider: HocuspocusProvider | null;
  collabStatus: WebSocketStatus;
  showComments?: boolean;
  onToggleComments?: () => void;
  showRaw?: boolean;
  onToggleRaw?: () => void;
  showToc?: boolean;
  onToggleToc?: () => void;
  page?: Page | undefined;
}








export function EditorHeader({ workspaceSlug, pageId, initialTitle, initialIcon, provider, collabStatus, showComments, onToggleComments, showRaw, onToggleRaw, showToc, onToggleToc, page }: EditorHeaderProps) {
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const { title, setTitle } = usePageTitle(pageId, initialTitle ?? "Untitled");
  const [icon, setIcon] = useState<string | null>(initialIcon);
  const updatePageMutation = useUpdatePage();
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const { data: pageTree } = usePageTree(workspaceId ?? "");
  const flatPages = useMemo(() => {
    const result: Page[] = [];
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
  const { data: favorites } = useFavorites(workspaceId);
  const toggleFavoriteMutation = useToggleFavorite();

  const isFavorite = favorites?.some(f => f.pageId === pageId) ?? false;

  const handleToggleFavorite = async () => {
    if (!workspaceId) return;
    try {
      await toggleFavoriteMutation.mutateAsync({
        pageId,
        isFavorite,
        workspaceId
      });
    } catch {
      showErrorToast('Failed to toggle favorite');
    }
  };

  useEffect(() => {
    setIcon(initialIcon);
  }, [initialIcon]);

  const handleIconChange = async (newIcon: string | null) => {
    setIcon(newIcon);
    try {
      await updatePageMutation.mutateAsync({
        pageId,
        updates: { icon: newIcon },
      });
    } catch {
      showErrorToast("Failed to update icon");
      setIcon(initialIcon);
    }
  };

  return (
    <div className="group flex flex-col gap-6 mb-8">
      <div className="flex items-center gap-2 pl-[54px] text-sm font-medium text-zinc-500 dark:text-zinc-400">
        {workspaceId && (
          <Breadcrumbs
            pages={flatPages}
            currentPageId={pageId}
            workspaceName={workspace?.name ?? workspaceSlug}
            workspaceSlug={workspaceSlug}
          />
        )}
        <div className="ml-auto">
          <CollabStatus provider={provider} status={collabStatus} />
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="relative flex-1 flex items-center">
          <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center justify-center w-[42px] h-[42px]">
            <EmojiPicker icon={icon} onChange={handleIconChange}>
              <div className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-3xl">
                {icon ? icon : <FileText className="w-8 h-8 text-zinc-400 dark:text-zinc-500" />}
              </div>
            </EmojiPicker>
          </div>
          <div className="pl-[54px] w-full">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-4xl md:text-5xl font-bold text-zinc-900 dark:text-zinc-50 bg-transparent outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-700 focus:ring-0 focus:border-transparent transition-colors break-words"
              placeholder="Page Title"
              autoComplete="off"
              data-testid="page-title"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onToggleRaw && (
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleRaw}
                className={`p-2 rounded-md transition-colors cursor-pointer ${
                  showRaw
                    ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                    : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
                title={showRaw ? "Hide raw markdown" : "Show raw markdown"}
              >
                <Code2 size={20} />
              </button>
              {showRaw && (
                <span className="text-xs font-semibold tracking-wide uppercase px-2 py-1 rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  Read-only
                </span>
              )}
            </div>
          )}
          {onToggleComments && (
            <button
              onClick={onToggleComments}
              className={`p-2 rounded-md transition-colors cursor-pointer ${
                showComments 
                  ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20" 
                  : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
              title={showComments ? "Hide comments" : "Show comments"}
            >
              <MessageSquare size={20} />
            </button>
          )}
          {onToggleToc && (
            <button
              onClick={onToggleToc}
              className={`p-2 rounded-md transition-colors cursor-pointer ${
                showToc
                  ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20"
                  : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
              title={showToc ? "Hide table of contents" : "Show table of contents"}
            >
              <List size={20} />
            </button>
          )}
          <button
            onClick={handleToggleFavorite}
            className={`p-2 rounded-md transition-colors cursor-pointer ${
              isFavorite 
                ? "text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20" 
                : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star size={20} fill={isFavorite ? "currentColor" : "none"} />
          </button>
          {page && (
            <>
              <button
                onClick={() => setIsShareDialogOpen(true)}
                className={`p-2 rounded-md transition-colors cursor-pointer ${
                  page.isPublic
                    ? "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20"
                    : "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
                title="Share to web"
              >
                <Share size={20} />
              </button>
              {isShareDialogOpen && (
                <PublicShareDialog
                  page={page}
                  onClose={() => setIsShareDialogOpen(false)}
                />
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}











