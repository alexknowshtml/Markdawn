import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type SearchResult = {
  id: string;
  title: string;
  icon: string | null;
  workspaceSlug: string;
  path: string[];
};

export function SearchDialog() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const hasResults = results.length > 0;
  const trimmedQuery = useMemo(() => query.trim(), [query]);

  const closeDialog = () => {
    setIsOpen(false);
    setQuery("");
    setResults([]);
    setIsLoading(false);
    setActiveIndex(-1);
  };

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isShortcut) {
        event.preventDefault();
        setIsOpen(true);
        return;
      }

      if (!isOpen) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (!hasResults) {
            return -1;
          }
          return Math.min(prev + 1, results.length - 1);
        });
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => {
          if (!hasResults) {
            return -1;
          }
          return Math.max(prev - 1, 0);
        });
      }

      if (event.key === "Enter") {
        if (activeIndex >= 0 && results[activeIndex]) {
          event.preventDefault();
          const target = results[activeIndex];
          navigate(`/app/${target.workspaceSlug}/${target.id}`);
          closeDialog();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          throw new Error("Failed to search");
        }
        const data = await res.json();
        const nextResults = Array.isArray(data?.results) ? (data.results as SearchResult[]) : [];
        setResults(nextResults);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
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
  }, [isOpen, trimmedQuery]);

  useEffect(() => {
    if (!hasResults) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(0);
  }, [hasResults, results]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/40 backdrop-blur-sm px-4 py-20"
      onClick={closeDialog}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative border-b border-zinc-200 dark:border-zinc-700 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages..."
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10"
          />
          {isLoading && (
            <div className="absolute right-6 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-700 dark:border-t-zinc-300" />
            </div>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {!trimmedQuery && (
            <div className="px-3 py-6 text-sm text-zinc-500 dark:text-zinc-400 text-center">Type to search...</div>
          )}

          {trimmedQuery && !isLoading && !hasResults && (
            <div className="px-3 py-6 text-sm text-zinc-500 dark:text-zinc-400 text-center">No pages found</div>
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
                    className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                      index === activeIndex
                        ? "bg-zinc-900 dark:bg-zinc-700 text-white"
                        : "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <div className="text-sm font-medium truncate">{result.title}</div>
                    <div
                      className={`text-xs ${
                        index === activeIndex ? "text-zinc-200 dark:text-zinc-300" : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {result.workspaceSlug}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
