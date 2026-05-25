import Fuse from 'fuse.js';
import { FileText, Plus } from 'lucide-react';
import type React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type WikiLinkPage = {
  id: string;
  title: string;
  icon: string | null;
};

interface WikiLinkSuggestionsProps {
  isOpen: boolean;
  query: string;
  pages: WikiLinkPage[];
  position: { x: number; y: number; top?: number; bottom?: number } | null;
  onSelect: (page: WikiLinkPage) => void;
  onClose: () => void;
  onAddPage?: (title: string) => void;
}

const MAX_RESULTS = 10;
const MENU_WIDTH = 320;
const MENU_OVERFLOW_THRESHOLD = 320;

export function WikiLinkSuggestions({
  isOpen,
  query,
  pages,
  position,
  onSelect,
  onClose,
  onAddPage,
}: WikiLinkSuggestionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
    opacity: 0,
    pointerEvents: 'none',
  });
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');

  const trimmedQuery = query.trim();

  // Initialize Fuse.js for fuzzy search
  const fuse = useMemo(() => {
    return new Fuse(pages, {
      keys: ['title'],
      threshold: 0.4,
      distance: 100,
      ignoreLocation: true,
    });
  }, [pages]);

  const results = useMemo(() => {
    if (!trimmedQuery) {
      return pages.slice(0, MAX_RESULTS);
    }
    const searchResults = fuse.search(trimmedQuery);
    return searchResults.map((r) => r.item).slice(0, MAX_RESULTS);
  }, [fuse, trimmedQuery, pages]);

  const totalItems = results.length + (onAddPage ? 1 : 0);

  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !position || !containerRef.current) {
      if (!isOpen) {
        setMenuStyle({ opacity: 0, pointerEvents: 'none' });
      }
      return;
    }

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const x = position.x;
    let newPlacement: 'top' | 'bottom' = 'bottom';

    const bottomCoord = position.bottom ?? position.y;
    const topCoord = position.top ?? position.y - 20;

    if (bottomCoord + MENU_OVERFLOW_THRESHOLD > viewportHeight - 20) {
      newPlacement = 'top';
    }

    setPlacement(newPlacement);

    const style: React.CSSProperties = {
      position: 'fixed',
      left: Math.max(20, Math.min(x, viewportWidth - MENU_WIDTH - 20)),
      opacity: 1,
      pointerEvents: 'auto',
      zIndex: 100,
    };

    if (newPlacement === 'top') {
      style.bottom = viewportHeight - topCoord + 8;
    } else {
      style.top = bottomCoord + 4;
    }

    setMenuStyle(style);
  }, [isOpen, position]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((prev) => (totalItems === 0 ? 0 : (prev + 1) % totalItems));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((prev) => (totalItems === 0 ? 0 : (prev - 1 + totalItems) % totalItems));
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (selectedIndex < results.length) {
          const selected = results[selectedIndex];
          if (selected) onSelect(selected);
        } else if (selectedIndex === results.length && onAddPage) {
          onAddPage(trimmedQuery);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, onSelect, results, selectedIndex, totalItems, onAddPage, trimmedQuery]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      data-testid="wikilink-suggestions"
      className={`w-80 max-w-[calc(100vw-2rem)] rounded-xl border shadow-2xl overflow-hidden animate-in fade-in duration-100 ${
        placement === 'bottom'
          ? 'zoom-in-95 slide-in-from-top-2'
          : 'zoom-in-95 slide-in-from-bottom-2'
      } bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100`}
      style={menuStyle}
    >
      <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800/50">
        Link to page
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-zinc-800">
        {results.length === 0 && !trimmedQuery ? (
          <div className="px-3 py-4 text-center text-sm text-zinc-500">Type to search...</div>
        ) : results.length === 0 && trimmedQuery ? (
          <div className="px-3 py-4 text-center text-sm text-zinc-500">No matches</div>
        ) : (
          <>
            {results.map((page, index) => (
              <button
                key={page.id}
                type="button"
                onClick={() => onSelect(page)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-all ${
                  index === selectedIndex
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/50 text-base">
                  {page.icon ? (
                    page.icon
                  ) : (
                    <FileText className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-500" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{page.title}</span>
              </button>
            ))}

            {results.length > 0 && onAddPage && (
              <div className="h-px bg-zinc-100 dark:bg-zinc-800/50 my-1 mx-1" />
            )}
          </>
        )}

        {onAddPage && (
          <button
            type="button"
            onClick={() => onAddPage(trimmedQuery)}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-all ${
              selectedIndex === results.length
                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'
            }`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/50">
              <Plus className="h-4 w-4 text-zinc-500 dark:text-zinc-500" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {trimmedQuery ? `New "${trimmedQuery}" page` : 'Add new page'}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
