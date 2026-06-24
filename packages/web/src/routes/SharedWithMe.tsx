import type { SharedWithMeItem } from '@markdawn/shared';
import { FileText, Folder } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSharedWithMe } from '../hooks/use-shared-with-me';
import { buildFolderPath, buildPagePath } from '../utils/url';

export default function SharedWithMe() {
  const { data: items, isLoading, error } = useSharedWithMe();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 p-3 text-sm text-red-500 bg-zinc-100 dark:bg-zinc-800/50 rounded-md border border-red-200 dark:border-red-900/30">
        Failed to load shared content
      </div>
    );
  }

  const sharedItems = items ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Shared with me</h1>
      {sharedItems.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No one has shared anything with you yet.
        </p>
      ) : (
        <div className="space-y-2">
          {sharedItems.map((item: SharedWithMeItem) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.entityType === 'page') {
                  navigate(buildPagePath(item.title, item.entityId));
                } else {
                  navigate(buildFolderPath(item.title, item.entityId));
                }
              }}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900 transition-colors text-left cursor-pointer"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                {item.entityType === 'folder' ? <Folder size={16} /> : <FileText size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                  {item.title}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                  {item.entityType} · {item.permission}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
