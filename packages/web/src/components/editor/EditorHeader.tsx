import React from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../../hooks/usePageTitle';

interface EditorHeaderProps {
  workspaceSlug: string;
  pageId: string;
  initialTitle: string;
}

export function EditorHeader({ workspaceSlug, pageId, initialTitle }: EditorHeaderProps) {
  const { title, setTitle } = usePageTitle(pageId, initialTitle ?? 'Untitled');

  return (
    <div className="group flex flex-col gap-4 mb-4">
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Link
          to={`/app/${workspaceSlug}`}
          className="hover:text-zinc-900 transition-colors hover:underline decoration-zinc-300 underline-offset-4"
        >
          {workspaceSlug}
        </Link>
        <span className="text-zinc-300">/</span>
        <span className="text-zinc-900 font-medium truncate max-w-[300px]">
          {title || 'Untitled'}
        </span>
      </div>

      <div className="relative">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-4xl font-bold text-zinc-900 bg-transparent outline-none placeholder:text-zinc-300 break-words"
          placeholder="Page Title"
          autoComplete="off"
          data-testid="page-title"
        />
      </div>
    </div>
  );
}
