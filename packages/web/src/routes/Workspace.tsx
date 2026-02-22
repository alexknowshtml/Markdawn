import React, { useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../hooks/use-workspaces';
import { usePageTree } from '../hooks/use-pages';
import { useCreatePage } from '../hooks/use-pages';
import { showErrorToast } from "../utils/toast"
import { EmptyState } from '../components/EmptyState';
import { FileText } from 'lucide-react';

export default function Workspace() {
  const navigate = useNavigate();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const { data: workspace } = useWorkspace(workspaceSlug);
  const { data: pages, isLoading, error, refetch } = usePageTree(workspace?.id ?? '');
  const createPageMutation = useCreatePage();

  useEffect(() => {
    if (workspace && workspaceSlug && workspace.slug !== workspaceSlug) {
      navigate(`/app/${workspace.slug}`, { replace: true });
    }
  }, [navigate, workspace, workspaceSlug]);

  const handleCreatePage = async () => {
    if (!workspace?.id) return;
    try {
      const newPage = await createPageMutation.mutateAsync({ workspaceId: workspace.id });
      navigate(`/app/${workspace.slug}/${newPage.id}`);
    } catch {
      showErrorToast('Failed to create page');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
          {workspace?.name || workspaceSlug}
        </h1>
        <button className="px-4 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-md text-sm hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors cursor-pointer" onClick={handleCreatePage}>
          New Page
        </button>
      </div>

      {error ? (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-md flex items-center justify-between">
          <span>Failed to load pages.</span>
          <button 
            onClick={() => refetch()}
            className="px-3 py-1 bg-red-100 dark:bg-red-900/40 hover:bg-red-200 dark:hover:bg-red-900/60 rounded text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-fade-in">
          {[1, 2, 3, 4, 5, 6].map((id) => (
            <div key={id} className="block p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg">
              <div className="h-32 bg-zinc-100 dark:bg-zinc-800 rounded-md mb-4 animate-pulse" />
              <div className="h-5 bg-zinc-100 dark:bg-zinc-800 rounded w-3/4 mb-2 animate-pulse" />
              <div className="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-1/2 animate-pulse" />
            </div>
          ))}
        </div>
      ) : !pages || pages.length === 0 ? (
        <EmptyState
          icon={<FileText size={24} />}
          title="No pages yet"
          description="Create your first page to start writing."
          actionLabel="Create your first page"
          onAction={handleCreatePage}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {pages.map((page, index) => (
            <Link 
              key={page.id}
              to={`/app/${workspace?.slug ?? workspaceSlug}/${page.id}`}
              className="block p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-md hover:scale-[1.02] transition-all duration-200 animate-slide-up"
              style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'both' }}
            >
              <div 
                className="h-32 bg-zinc-50 dark:bg-zinc-800/50 rounded-md mb-4 flex items-center justify-center text-zinc-300 dark:text-zinc-600 overflow-hidden"
                style={{
                  background: page.coverType === 'gradient' ? page.coverValue! : undefined,
                  backgroundColor: page.coverType === 'solid' ? page.coverValue! : undefined,
                }}
              >
                {page.icon ? <span className="text-4xl drop-shadow-sm">{page.icon}</span> : (!page.coverType && 'Cover Image')}
              </div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-1 truncate">
                {page.title || 'Untitled'}
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Last edited {new Date(page.updatedAt).toLocaleDateString()}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
