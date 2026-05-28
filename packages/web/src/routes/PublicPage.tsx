import { editorViewOptionsCtx } from '@milkdown/core';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMilkdown } from '../hooks/useMilkdown';

const API_BASE = '/api';

interface PublicPageData {
  title: string;
  icon: string | null;
  coverType: string | null;
  coverValue: string | null;
  content: number[] | null;
}

async function fetchPublicPage(pageId: string): Promise<PublicPageData> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('Page not found');
    }
    throw new Error('Failed to fetch page');
  }
  return res.json();
}

function decodePageContent(ydoc: unknown): string {
  if (!ydoc || !Array.isArray(ydoc) || ydoc.length === 0) return '';
  const hasNullByte = ydoc.includes(0);
  if (!hasNullByte) {
    return new TextDecoder().decode(new Uint8Array(ydoc as number[]));
  }
  return '';
}

function MilkdownViewer({ markdown }: { markdown: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { setContainer, editor } = useMilkdown({ initialValue: markdown });

  useEffect(() => {
    setContainer(containerRef.current as HTMLDivElement | null);
  }, [setContainer]);

  useEffect(() => {
    if (editor) {
      try {
        editor.action((ctx) => {
          ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
        });
      } catch {
        // ignore
      }
    }
  }, [editor]);

  // Update content when markdown changes by replacing whole container.
  // useMilkdown uses defaultValueCtx only on init; to update editor content after
  // creation, call replaceAllMarkdown via the window API exposed by useMilkdown.
  useEffect(() => {
    // If editor is available, call global helper to replace content
    (window as unknown as { replaceAllMarkdown?: (content: string) => void }).replaceAllMarkdown?.(
      markdown,
    );
  }, [markdown]);

  return <div ref={containerRef} className="prose max-w-none px-0 py-0" />;
}

export default function PublicPage() {
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const pageId = slugAndId?.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )?.[1];

  const {
    data: page,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['public-page', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchPublicPage(pageId);
    },
    enabled: !!pageId,
    retry: false,
  });

  const markdown = useMemo(() => decodePageContent(page?.content ?? null), [page?.content]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
        <header className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center px-6">
          <Link
            to="/"
            className="font-semibold text-lg tracking-tight hover:opacity-80 transition-opacity"
          >
            Markdawn
          </Link>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        </div>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
        <header className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center px-6">
          <Link
            to="/"
            className="font-semibold text-lg tracking-tight hover:opacity-80 transition-opacity"
          >
            Markdawn
          </Link>
        </header>
        <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-10 text-center mt-20">
          <h1 className="text-2xl font-semibold mb-2">Page not found</h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            The page you are looking for does not exist or the link has expired.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <header className="h-14 border-b border-zinc-200 dark:border-zinc-800 flex items-center px-6">
        <Link
          to="/"
          className="font-semibold text-lg tracking-tight hover:opacity-80 transition-opacity"
        >
          Markdawn
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-10 animate-fade-in">
          {(page.coverType || page.coverValue) && (
            <div
              className="w-full h-[200px] rounded-xl mb-8 overflow-hidden"
              style={{
                background:
                  page.coverType === 'gradient' ? (page.coverValue ?? undefined) : undefined,
                backgroundColor:
                  page.coverType === 'solid' ? (page.coverValue ?? undefined) : undefined,
              }}
            />
          )}

          <div className="mb-8">
            <h1 className="text-4xl font-bold flex items-center gap-3">
              {page.icon && <span>{page.icon}</span>}
              {page.title || 'Untitled'}
            </h1>
          </div>

          <div className="rounded-xl p-6 bg-transparent">
            <MilkdownViewer markdown={markdown} />
          </div>
        </div>
      </main>
    </div>
  );
}
