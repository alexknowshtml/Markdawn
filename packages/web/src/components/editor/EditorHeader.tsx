import React from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import { Link } from "react-router-dom";
import { usePageTitle } from "../../hooks/usePageTitle";
import { CollabStatus } from "./CollabStatus";

interface EditorHeaderProps {
  workspaceSlug: string;
  pageId: string;
  initialTitle: string;
  provider: HocuspocusProvider | null;
  collabStatus: WebSocketStatus;
}

export function EditorHeader({ workspaceSlug, pageId, initialTitle, provider, collabStatus }: EditorHeaderProps) {
  const { title, setTitle } = usePageTitle(pageId, initialTitle ?? "Untitled");

  return (
    <div className="group flex flex-col gap-6 mb-8">
      <div className="flex items-center gap-2 pl-[54px] text-sm font-medium text-zinc-500 dark:text-zinc-400">
        <Link
          to={`/app/${workspaceSlug}`}
          className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors px-1.5 py-0.5 -ml-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
        >
          {workspaceSlug}
        </Link>
        <svg className="w-4 h-4 text-zinc-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-zinc-900 dark:text-zinc-100 truncate max-w-[200px] md:max-w-[300px]">
          {title || "Untitled"}
        </span>
        <div className="ml-auto">
          <CollabStatus provider={provider} status={collabStatus} />
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="relative flex-1 pl-[54px]">
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
        <div className="flex items-center gap-2 shrink-0">
        </div>
      </div>
    </div>
  );
}
