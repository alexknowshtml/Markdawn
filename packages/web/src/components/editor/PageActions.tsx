import type { Page } from '@markdawn/shared';
import { Share, Star } from 'lucide-react';
import { useState } from 'react';
import { useFavorites, useToggleFavorite } from '../../hooks/use-favorites';
import { Tooltip } from '../Tooltip';
import { PublicShareDialog } from './PublicShareDialog';

interface PageActionsProps {
  pageId: string;
  page?: Page | undefined;
}

export function PageActions({ pageId, page }: PageActionsProps) {
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const { data: favorites } = useFavorites();
  const toggleFavoriteMutation = useToggleFavorite();

  const isFavorite = favorites?.some((f) => f.pageId === pageId) ?? false;

  const handleToggleFavorite = () => {
    toggleFavoriteMutation.mutate({
      pageId,
      ...(page?.title !== undefined ? { title: page.title } : {}),
      icon: page?.icon ?? null,
      ownerId: page?.ownerId ?? null,
      isFavorite,
    });
  };

  return (
    <div className="flex items-center gap-2 shrink-0">
      <Tooltip label={isFavorite ? 'Remove from favorites' : 'Add to favorites'} position="bottom">
        <button
          type="button"
          onClick={handleToggleFavorite}
          className={`p-2 rounded-md transition-colors cursor-pointer ${
            isFavorite
              ? 'text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
              : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          <Star size={20} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </Tooltip>
      {page && (
        <>
          <Tooltip label="Share to web" position="bottom">
            <button
              type="button"
              onClick={() => setIsShareDialogOpen(true)}
              data-testid="page-share-btn"
              className={`p-2 rounded-md transition-colors cursor-pointer ${
                page.isPublic
                  ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Share size={20} />
            </button>
          </Tooltip>
          {isShareDialogOpen && (
            <PublicShareDialog
              entityType="page"
              entityId={page.id}
              title={page.title}
              onClose={() => setIsShareDialogOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
