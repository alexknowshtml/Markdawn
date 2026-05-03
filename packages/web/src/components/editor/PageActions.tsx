import type { Page } from '@markdawn/shared';
import { Share, Star } from 'lucide-react';
import React, { useState } from 'react';
import { useFavorites, useToggleFavorite } from '../../hooks/use-favorites';
import { useWorkspaces } from '../../hooks/use-workspaces';
import { showErrorToast } from '../../utils/toast';
import { Tooltip } from '../Tooltip';
import { PublicShareDialog } from './PublicShareDialog';

interface PageActionsProps {
  workspaceSlug: string;
  pageId: string;
  page?: Page | undefined;
}

export function PageActions({ workspaceSlug, pageId, page }: PageActionsProps) {
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const { data: favorites } = useFavorites(workspaceId);
  const toggleFavoriteMutation = useToggleFavorite();

  const isFavorite = favorites?.some((f) => f.pageId === pageId) ?? false;

  const handleToggleFavorite = async () => {
    if (!workspaceId) return;
    try {
      await toggleFavoriteMutation.mutateAsync({
        pageId,
        isFavorite,
        workspaceId,
      });
    } catch {
      showErrorToast('Failed to toggle favorite');
    }
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
            <PublicShareDialog page={page} onClose={() => setIsShareDialogOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}
