import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { X, History, RotateCcw, Save } from 'lucide-react';
import { useCreateVersion, useRestoreVersion, useVersions } from '../../hooks/use-versions';

interface VersionHistoryPanelProps {
  pageId: string;
  pageTitle: string;
  onClose: () => void;
}

const formatDateTime = (value: string | null) => {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).format(date);
};

export function VersionHistoryPanel({ pageId, pageTitle, onClose }: VersionHistoryPanelProps) {
  const { data: versions = [], isLoading } = useVersions(pageId);
  const createVersion = useCreateVersion(pageId);
  const restoreVersion = useRestoreVersion(pageId);
  const [isSaving, setIsSaving] = useState(false);

  const timeline = useMemo(() => versions, [versions]);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    createVersion.mutate(pageTitle, {
      onSettled: () => setIsSaving(false),
    });
  };

  const handleRestore = (versionId: string) => {
    if (window.confirm('Restore this version title? This will overwrite the current title.')) {
      restoreVersion.mutate(versionId);
    }
  };

  return (
    <aside className="w-80 border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 h-full flex flex-col flex-shrink-0 z-40">
      <div className="h-14 px-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100 font-medium">
          <History size={18} />
          <span>Version History</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || createVersion.isPending}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-2 text-sm font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors disabled:opacity-60"
        >
          <Save size={16} />
          Save snapshot
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-zinc-300 dark:border-zinc-600 border-t-zinc-600 dark:border-t-zinc-300 rounded-full animate-spin" />
          </div>
        ) : timeline.length === 0 ? (
          <div className="text-center py-8 text-zinc-500 dark:text-zinc-400 text-sm">
            No snapshots yet.
          </div>
        ) : (
          <ol className="relative border-s border-zinc-200 dark:border-zinc-700">
            {timeline.map((version, index) => (
              <li key={version.id} className={clsx('ms-4 pb-6', index === timeline.length - 1 ? 'pb-0' : 'pb-6')}>
                <span className="absolute -start-1.5 flex h-3 w-3 items-center justify-center rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900" />
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {version.title ?? 'Untitled'}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {formatDateTime(version.createdAt)}
                      </div>
                      {version.createdByName && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {version.createdByName}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRestore(version.id)}
                      disabled={restoreVersion.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-60"
                    >
                      <RotateCcw size={12} />
                      Restore
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
