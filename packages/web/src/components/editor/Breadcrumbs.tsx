import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import type { Page } from "@markdawn/shared";

interface BreadcrumbsProps {
  pages: Page[];
  currentPageId: string;
  workspaceName: string;
  workspaceSlug: string;
}

export function Breadcrumbs({ pages, currentPageId, workspaceName, workspaceSlug }: BreadcrumbsProps) {
  const breadcrumbPages = useMemo(() => {
    if (!pages.length || !currentPageId) {
      return [] as Page[];
    }

    const pageMap = new Map(pages.map((page) => [page.id, page]));
    const path: Page[] = [];
    const visited = new Set<string>();
    let cursor: Page | undefined = pageMap.get(currentPageId);

    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      path.push(cursor);
      cursor = cursor.parentId ? pageMap.get(cursor.parentId) : undefined;
    }

    return path.reverse();
  }, [currentPageId, pages]);

  return (
    <div className="flex items-center gap-1 text-sm font-medium text-zinc-500 dark:text-zinc-400 overflow-x-auto whitespace-nowrap scrollbar-hide">
      <Link
        to={`/app/${workspaceSlug}`}
        className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors px-1.5 py-0.5 -ml-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
      >
        {workspaceName}
      </Link>
      {breadcrumbPages.map((page, index) => {
        const isLast = index === breadcrumbPages.length - 1;
        return (
          <React.Fragment key={page.id}>
            <span className="text-zinc-300 dark:text-zinc-600">&gt;</span>
            {isLast ? (
              <span className="text-zinc-900 dark:text-zinc-100 truncate max-w-[200px] md:max-w-[300px] px-1.5 py-0.5">
                {page.title || "Untitled"}
              </span>
            ) : (
              <Link
                to={`/app/${workspaceSlug}/${page.id}`}
                className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors px-1.5 py-0.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/50 truncate max-w-[150px]"
              >
                {page.title || "Untitled"}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
