import { FileText, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import {
  useEmptyTrash,
  usePermanentDeletePage,
  useRestorePage,
  useTrashPages,
} from '../hooks/use-pages';
import { showSuccessToast } from '../utils/toast';

export default function Trash() {
  const { data: trashPages, isLoading } = useTrashPages();
  const restoreMutation = useRestorePage();
  const permanentDeleteMutation = usePermanentDeletePage();
  const emptyTrashMutation = useEmptyTrash();

  const [pageToDelete, setPageToDelete] = useState<{ id: string; title: string } | null>(null);
  const [showEmptyAllConfirm, setShowEmptyAllConfirm] = useState(false);

  const handleRestore = (pageId: string) => {
    restoreMutation.mutate(pageId, {
      onSuccess: () => showSuccessToast('Page restored'),
    });
  };

  const handlePermanentDelete = () => {
    if (!pageToDelete) return;
    permanentDeleteMutation.mutate(pageToDelete.id, {
      onSuccess: () => {
        showSuccessToast('Page permanently deleted');
        setPageToDelete(null);
      },
    });
  };

  const handleEmptyAll = () => {
    emptyTrashMutation.mutate(undefined, {
      onSuccess: () => setShowEmptyAllConfirm(false),
    });
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <Link
            to="/app"
            className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Back to home
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Trash</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Deleted pages appear here. Restore them or delete permanently.
          </p>
        </div>
        {trashPages && trashPages.length > 0 && (
          <button
            type="button"
            onClick={() => setShowEmptyAllConfirm(true)}
            disabled={emptyTrashMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Trash2 size={14} />
            <span>Empty all</span>
          </button>
        )}
      </div>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-zinc-900 dark:border-zinc-100" />
          </div>
        ) : trashPages && trashPages.length > 0 ? (
          <div className="space-y-2">
            {trashPages.map((page) => (
              <div
                key={page.id}
                className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex-shrink-0 text-zinc-400 dark:text-zinc-500">
                    {page.icon ? (
                      <span className="text-lg leading-none">{page.icon}</span>
                    ) : (
                      <FileText size={18} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {page.title || 'Untitled'}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Deleted{' '}
                      {page.deletedAt ? new Date(page.deletedAt).toLocaleDateString() : 'Unknown'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                  <button
                    type="button"
                    onClick={() => handleRestore(page.id)}
                    disabled={restoreMutation.isPending}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 cursor-pointer"
                    title="Restore page"
                  >
                    <RotateCcw size={14} />
                    <span>Restore</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPageToDelete({ id: page.id, title: page.title })}
                    disabled={permanentDeleteMutation.isPending}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 transition-colors disabled:opacity-50 cursor-pointer"
                    title="Delete permanently"
                  >
                    <Trash2 size={14} />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Trash2 size={24} />}
            title="Trash is empty"
            description="Deleted pages will appear here."
          />
        )}
      </section>

      <ConfirmDialog
        isOpen={!!pageToDelete}
        title="Delete permanently"
        message={`Are you sure you want to permanently delete "${pageToDelete?.title || 'Untitled'}"? This action cannot be undone.`}
        confirmText="Delete permanently"
        onConfirm={handlePermanentDelete}
        onCancel={() => setPageToDelete(null)}
        loading={permanentDeleteMutation.isPending}
      />

      <ConfirmDialog
        isOpen={showEmptyAllConfirm}
        title="Empty trash"
        message="Are you sure you want to permanently delete all items in the trash? This action cannot be undone."
        confirmText="Empty trash"
        onConfirm={handleEmptyAll}
        onCancel={() => setShowEmptyAllConfirm(false)}
        loading={emptyTrashMutation.isPending}
      />
    </div>
  );
}
