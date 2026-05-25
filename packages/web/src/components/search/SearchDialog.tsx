import { FileText, Filter } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../EmptyState';

type SearchResult = {
  id: string;
  title: string;
  icon: string | null;
  workspaceSlug: string;
  path: string[];
  breadcrumb?: string[];
};

export function SearchDialog() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showFilters, setShowFilters] = useState(false);
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');
  const [parentId, setParentId] = useState('');

  const hasResults = results.length > 0;
  const trimmedQuery = useMemo(() => query.trim(), [query]);

  const closeDialog = () => {
    setIsOpen(false);
    setQuery('');
    setResults([]);
    setIsLoading(false);
    setActiveIndex(-1);
    setShowFilters(false);
    setCreatedAfter('');
    setCreatedBefore('');
    setParentId('');
  };

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: closeDialog only uses stable setState setters, stale closure is safe
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (isShortcut) {
        event.preventDefault();
        setIsOpen(true);
        return;
      }

      if (!isOpen) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (!hasResults) {
            return -1;
          }
          return Math.min(prev + 1, results.length - 1);
        });
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (!hasResults) {
            return -1;
          }
          return Math.max(prev - 1, 0);
        });
      }

      if (event.key === 'Enter') {
        if (activeIndex >= 0 && results[activeIndex]) {
          event.preventDefault();
          const target = results[activeIndex];
          navigate(`/app/${target.workspaceSlug}/${target.id}`);
          closeDialog();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, hasResults, isOpen, navigate, results]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!trimmedQuery) {
      setResults([]);
      setIsLoading(false);
      setActiveIndex(-1);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);

    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmedQuery });
        if (createdAfter) {
          params.set('createdAfter', createdAfter);
        }
        if (createdBefore) {
          params.set('createdBefore', createdBefore);
        }
        if (parentId) {
          params.set('parentId', parentId);
        }

        const res = await fetch(`/api/search?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) {
          throw new Error('Failed to search');
        }
        const data = await res.json();
        const nextResults = Array.isArray(data?.results) ? (data.results as SearchResult[]) : [];
        setResults(nextResults);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [createdAfter, createdBefore, isOpen, parentId, trimmedQuery]);

  useEffect(() => {
    if (!hasResults) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(0);
  }, [hasResults]);

  if (!isOpen) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; inner div has role="dialog"
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/50 backdrop-blur-sm px-4 py-20 animate-fade-in"
      onClick={closeDialog}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeDialog();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search results"
        className="w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl animate-slide-up overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-zinc-200 dark:border-zinc-800 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages..."
              className="flex-1 rounded-xl bg-transparent px-4 py-3 text-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500/20 dark:focus:ring-zinc-400/20 transition-shadow"
            />
            <button
              type="button"
              onClick={() => setShowFilters((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition"
            >
              <Filter className="h-4 w-4" />
              Filters
            </button>
          </div>
          {isLoading && (
            <div className="absolute right-6 top-1/2 -translate-y-1/2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-700 dark:border-t-zinc-300" />
            </div>
          )}
          {showFilters && (
            <div className="grid gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/20 p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Created after
                  <input
                    type="date"
                    value={createdAfter}
                    onChange={(event) => setCreatedAfter(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                  />
                </label>
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Created before
                  <input
                    type="date"
                    value={createdBefore}
                    onChange={(event) => setCreatedBefore(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                  />
                </label>
              </div>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Parent filter
                <select
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                >
                  <option value="">Any parent</option>
                  <option value="root">Root pages only</option>
                </select>
              </label>
            </div>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {trimmedQuery && !isLoading && (
            <div className="px-4 py-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {results.length} results
            </div>
          )}
          {!trimmedQuery && (
            <div className="px-4 py-14 text-center">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Type to search pages...</p>
            </div>
          )}

          {trimmedQuery && !isLoading && !hasResults && (
            <EmptyState
              compact
              icon={<FileText className="h-5 w-5" />}
              title="No results found"
              description={`We couldn't find anything matching "${trimmedQuery}"`}
            />
          )}

          {hasResults && (
            <ul className="space-y-1">
              {results.map((result, index) => (
                <li key={result.id}>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(`/app/${result.workspaceSlug}/${result.id}`);
                      closeDialog();
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`w-full rounded-xl px-4 py-3 text-left transition-all duration-200 flex items-center gap-3 ${
                      index === activeIndex
                        ? 'bg-zinc-100 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center justify-center w-8 h-8 rounded-md bg-zinc-200/50 dark:bg-zinc-700/50 text-lg shrink-0">
                      {result.icon ? (
                        result.icon
                      ) : (
                        <FileText className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{result.title}</div>
                      <div
                        className={`text-xs mt-0.5 truncate transition-colors ${
                          index === activeIndex
                            ? 'text-zinc-500 dark:text-zinc-400'
                            : 'text-zinc-400 dark:text-zinc-500'
                        }`}
                      >
                        {result.workspaceSlug}
                      </div>
                      {result.breadcrumb && result.breadcrumb.length > 0 && (
                        <div className="text-[11px] mt-1 text-zinc-400 dark:text-zinc-500 truncate">
                          {result.breadcrumb.join(' > ')}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          ↑↓ navigate, Enter select, Esc close
        </div>
      </div>
    </div>
  );
}
