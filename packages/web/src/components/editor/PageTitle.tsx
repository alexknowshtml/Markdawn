import React from 'react';
import { usePageTitle } from '../../hooks/usePageTitle';

interface PageTitleProps {
  pageId: string;
  initialTitle: string;
}

export function PageTitle({ pageId, initialTitle }: PageTitleProps) {
  const { title, setTitle } = usePageTitle(pageId, initialTitle ?? 'Untitled');

  return (
    <input
      type="text"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      className="w-full font-bold leading-tight text-zinc-900 dark:text-zinc-50 bg-transparent outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-700 focus:ring-0 focus:border-transparent transition-colors break-words font-serif"
      placeholder="Page Title"
      autoComplete="off"
      data-testid="page-title"
      style={{ fontSize: 'clamp(1.5rem, 3vw, 2.5rem)' }}
    />
  );
}
