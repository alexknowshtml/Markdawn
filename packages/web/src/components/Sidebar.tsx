import React from 'react';
import { useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Briefcase } from 'lucide-react';
import { PageTree } from './sidebar/PageTree';
import { useWorkspaces } from '../hooks/use-workspaces';

interface SidebarProps {
  className?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({ className, collapsed = false }: SidebarProps) {
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  
  const { data: workspaces } = useWorkspaces();
  const currentWorkspace = workspaces?.find(w => w.slug === workspaceSlug);

  return (
    <aside 
      className={clsx(
        "rounded-[2rem] border border-white/60 dark:border-zinc-700/50 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] w-full h-full flex flex-col transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] flex-shrink-0 z-40 relative overflow-hidden",
        collapsed ? "w-[68px]" : "w-[240px]",
        className
      )}
      data-testid={collapsed ? "sidebar-collapsed" : "sidebar"}
    >
      <div 
        className={clsx(
          "absolute inset-0 flex flex-col items-center py-5 transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)]",
          collapsed ? "opacity-100 translate-x-0 pointer-events-auto delay-100" : "opacity-0 -translate-x-8 pointer-events-none"
        )}
      >
        <div className="flex-1 flex flex-col items-center gap-4 w-full pt-2">
        </div>
      </div>

      <div 
        className={clsx(
          "absolute inset-0 flex flex-col transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] w-[240px]",
          collapsed ? "opacity-0 translate-x-8 pointer-events-none" : "opacity-100 translate-x-0 pointer-events-auto delay-100"
        )}
      >
        <div className="relative z-0 flex-1 overflow-hidden flex flex-col px-2 pt-3">
          {currentWorkspace && workspaceSlug ? (
            <PageTree workspaceId={currentWorkspace.id} workspaceSlug={workspaceSlug} />
          ) : (
            <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
              <Briefcase className="text-zinc-300 dark:text-zinc-600 mb-2" size={32} />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Select a workspace to view pages
              </p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
