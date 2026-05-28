import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useShareContext } from '../contexts/ShareContext';
import Page from './Page';

async function fetchPage(pageId: string) {
  const res = await fetch(`/api/pages/${pageId}`);
  if (!res.ok) throw new Error('Failed to fetch page');
  return res.json();
}

export default function PageEntry() {
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const pageId = slugAndId?.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )?.[1];

  const { data: page, isLoading } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchPage(pageId);
    },
    enabled: !!pageId,
    retry: false,
  });

  const { linkPermission } = useShareContext();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  return <Page linkPermission={linkPermission} />;
}
