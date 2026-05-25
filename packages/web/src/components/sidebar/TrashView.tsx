import { FileText, RotateCcw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
  useEmptyTrash,
  usePermanentDeletePage,
  useRestorePage,
  useTrashPages,
} from '../../hooks/use-pages';
import { showErrorToast, showSuccessToast } from '../../utils/toast';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';

interface TrashViewProps {
  workspaceId: string;
  onClose: () => void;
}

export function TrashView({ workspaceId, onClose }: TrashViewProps) {
  const { data: trashPages, isLoading } = useTrashPages(workspaceId);
  const restoreMutation = useRestorePage();
  const permanentDeleteMutation = usePermanentDeletePage();
  const emptyTrashMutation = useEmptyTrash();

  const [pageToDelete, setPageToDelete] = useState<{ id: string; title: string } | null>(null);
  const [showEmptyAllConfirm, setShowEmptyAllConfirm] = useState(false);

  const handleRestore = async (pageId: string) => {
    try {
      await restoreMutation.mutateAsync(pageId);
      showSuccessToast('Page restored');
    } catch (_error) {
      showErrorToast('Failed to restore page');
    }
  };

  const handlePermanentDelete = async () => {
    if (!pageToDelete) return;
    try {
      await permanentDeleteMutation.mutateAsync(pageToDelete.id);
      showSuccessToast('Page permanently deleted');
      setPageToDelete(null);
    } catch (_error) {
      showErrorToast('Failed to permanently delete page');
    }
  };

  const handleEmptyAll = async () => {
    try {
      await emptyTrashMutation.mutateAsync(workspaceId);
      setShowEmptyAllConfirm(false);
    } catch (_error) {
      showErrorToast('Failed to empty trash');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in">
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl animate-slide-up">
        <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-50">
            <Trash2 size={18} />
            <h2 className="text-lg font-semibold">Trash</h2>
          </div>
          <div className="flex items-center gap-2">
            {trashPages && trashPages.length > 0 && (
              <button
                type="button"
                onClick={() => setShowEmptyAllConfirm(true)}
                disabled={emptyTrashMutation.isPending}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Trash2 size={14} />
                <span>Empty all</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
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
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
                      title="Restore page"
                    >
                      <RotateCcw size={14} />
                      <span className="hidden sm:inline">Restore</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPageToDelete({ id: page.id, title: page.title })}
                      disabled={permanentDeleteMutation.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 transition-colors disabled:opacity-50"
                      title="Delete permanently"
                    >
                      <Trash2 size={14} />
                      <span className="hidden sm:inline">Delete</span>
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
        </div>
      </div>

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
