import type React from 'react';
import { useCallback, useRef } from 'react';
import type * as Y from 'yjs';
import { usePageTitle } from '../../hooks/usePageTitle';

interface PageTitleProps {
  pageId: string;
  initialTitle: string;
  ydoc?: Y.Doc | null;
}

export function PageTitle({ pageId, initialTitle, ydoc }: PageTitleProps) {
  const { title, setTitle, commitTitle } = usePageTitle(pageId, initialTitle ?? 'Untitled', ydoc);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleBlurOrEnter = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement> | React.FocusEvent<HTMLInputElement>) => {
      if ('key' in e && e.key !== 'Enter') return;
      const liveValue = inputRef.current?.value ?? title;
      commitTitle(liveValue);
    },
    [commitTitle, title],
  );

  return (
    <input
      ref={inputRef}
      type="text"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={handleBlurOrEnter}
      onKeyDown={handleBlurOrEnter}
      className="w-full font-bold leading-tight text-zinc-900 dark:text-zinc-50 bg-transparent outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-700 focus:ring-0 focus:border-transparent transition-colors break-words font-serif"
      placeholder="Page Title"
      autoComplete="off"
      data-testid="page-title"
      style={{ fontSize: 'clamp(1.5rem, 3vw, 2.5rem)' }}
    />
  );
}
