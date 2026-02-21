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
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/50 backdrop-blur-sm px-4 py-20 animate-fade-in"
      onClick={closeDialog}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl animate-slide-up overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative border-b border-zinc-200 dark:border-zinc-800 p-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages..."
            className="w-full rounded-xl bg-transparent px-4 py-3 text-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500/20 dark:focus:ring-zinc-400/20 transition-shadow"
          />
          {isLoading && (
            <div className="absolute right-6 top-1/2 -translate-y-1/2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-700 dark:border-t-zinc-300" />
            </div>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!trimmedQuery && (
            <div className="px-4 py-14 text-center">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Type to search pages...</p>
            </div>
          )}

          {trimmedQuery && !isLoading && !hasResults && (
            <div className="px-4 py-14 text-center">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">No results found</p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                We couldn't find anything matching "{trimmedQuery}"
              </p>
            </div>
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
                        ? "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 hover:text-zinc-900 dark:hover:text-zinc-200"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{result.title}</div>
                      <div
                        className={`text-xs mt-0.5 truncate transition-colors ${
                          index === activeIndex ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        {result.workspaceSlug}
                      </div>
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
