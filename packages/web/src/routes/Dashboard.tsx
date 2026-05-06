import { LayoutGrid } from 'lucide-react';
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaces } from '../hooks/use-workspaces';

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: workspaces, isLoading } = useWorkspaces();

  useEffect(() => {
    const firstWorkspace = workspaces?.[0];
    if (!isLoading && firstWorkspace) {
      navigate(`/app/${firstWorkspace.slug}`, { replace: true });
    }
  }, [isLoading, workspaces, navigate]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 animate-fade-in">
        <LayoutGrid className="w-12 h-12 text-zinc-300 dark:text-zinc-600 mb-4 animate-pulse" />
        <p className="text-sm">Loading workspaces...</p>
      </div>
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 animate-fade-in">
        <LayoutGrid className="w-12 h-12 text-zinc-300 dark:text-zinc-600 mb-4" />
        <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
          Select a workspace to get started
        </h2>
        <p className="text-sm">
          Workspaces help you organize your notes and collaborate with others.
        </p>
      </div>
    );
  }

  return null;
}
