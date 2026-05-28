import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { ShareProvider } from '../../contexts/ShareContext';
import { useAuth } from '../../hooks/useAuth';

async function fetchPagePublic(pageId: string) {
  const res = await fetch(`/api/pages/${pageId}`);
  if (!res.ok) throw new Error('Failed to fetch page');
  return res.json();
}

function extractPageId(slugAndId: string): string | null {
  const match = slugAndId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

type ShareablePageRouteProps = {
  children: ReactNode;
};

export function ShareablePageRoute({ children }: ShareablePageRouteProps) {
  const { data: session, isPending: authPending } = useAuth();
  const location = useLocation();
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const pageId = slugAndId ? extractPageId(slugAndId) : null;

  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchPagePublic(pageId);
    },
    enabled: !authPending && !!pageId && !session?.user,
    retry: false,
  });

  if (authPending || (!session?.user && pageLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4 w-full max-w-md p-8">
          <div className="h-12 w-12 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-shimmer" />
          <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-800 animate-shimmer" />
          <div className="h-3 w-48 rounded bg-zinc-100 dark:bg-zinc-900 animate-shimmer" />
        </div>
      </div>
    );
  }

  if (session?.user) {
    return <ShareProvider linkPermission={null}>{children}</ShareProvider>;
  }

  if (!pageId) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!page?.isPublic) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <ShareProvider linkPermission={page.linkPermission ?? null}>{children}</ShareProvider>;
}
