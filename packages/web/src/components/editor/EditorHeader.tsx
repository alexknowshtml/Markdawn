import React from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { Link } from "react-router-dom";
import { usePageTitle } from "../../hooks/usePageTitle";
import { ExportMenu } from "./ExportMenu";
import { ImportDialog } from "./ImportDialog";
import { CollabStatus } from "./CollabStatus";

interface EditorHeaderProps {
  workspaceSlug: string;
  pageId: string;
  initialTitle: string;
  provider: HocuspocusProvider | null;
}

export function EditorHeader({ workspaceSlug, pageId, initialTitle, provider }: EditorHeaderProps) {
  const { title, setTitle } = usePageTitle(pageId, initialTitle ?? "Untitled");

  return (
    <div className="group flex flex-col gap-4 mb-4">
      <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <Link
          to={`/app/${workspaceSlug}`}
          className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors hover:underline decoration-zinc-300 dark:decoration-zinc-600 underline-offset-4"
        >
          {workspaceSlug}
        </Link>
        <span className="text-zinc-300 dark:text-zinc-600">/</span>
        <span className="text-zinc-900 dark:text-zinc-100 font-medium truncate max-w-[300px]">
          {title || "Untitled"}
        </span>
        <CollabStatus provider={provider} />
      </div>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-4xl font-bold text-zinc-900 dark:text-zinc-50 bg-transparent outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600 break-words"
            placeholder="Page Title"
            autoComplete="off"
            data-testid="page-title"
          />
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu pageId={pageId} />
          <ImportDialog pageId={pageId} />
        </div>
      </div>
    </div>
  );
}
