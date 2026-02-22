import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { 
  LogOut, 
  User,
  PanelLeftClose,
  PanelLeftOpen,
  Briefcase,
  Settings,
  Trash2
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { HeaderActions } from './HeaderActions';
import { authClient } from "../lib/auth-client";
import { useWorkspaces } from '../hooks/use-workspaces';
import { PageTree } from './sidebar/PageTree';
import { useAuth } from '../hooks/useAuth';
import { WorkspaceSelector } from './workspace/WorkspaceSelector';
import { CreateWorkspaceModal } from './workspace/CreateWorkspaceModal';
import { TrashView } from './sidebar/TrashView';
import { useTrashPages } from '../hooks/use-pages';

interface SidebarProps {
  className?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({ className, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const navigate = useNavigate();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  
  const { data: session } = useAuth();
  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTrashModal, setShowTrashModal] = useState(false);

  const currentWorkspace = workspaces?.find(w => w.slug === workspaceSlug);
  const { data: trashPages } = useTrashPages(currentWorkspace?.id || '');


  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          navigate('/login');
        },
      },
    });
  };

  return (
    <aside 
      className={clsx(
        "border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 h-full flex flex-col transition-all duration-300 flex-shrink-0 z-50 relative overflow-hidden",
        collapsed ? "w-14" : "w-64",
        className
      )}
      data-testid={collapsed ? "sidebar-collapsed" : "sidebar"}
    >
      <div 
        className={clsx(
          "absolute inset-0 flex flex-col items-center py-4 transition-all duration-300",
          collapsed ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 -translate-x-8 pointer-events-none"
        )}
      >
        <button 
          onClick={onToggleCollapsed}
          className="p-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 mb-6 transition-colors cursor-pointer"
          title="Expand Sidebar"
        >
          <PanelLeftOpen size={20} />
        </button>
        
        <div className="flex-1 flex flex-col items-center gap-4 w-full">
          {workspaceSlug ? (
            <button 
              onClick={() => navigate(`/app/${workspaceSlug}/settings`)}
              className="w-8 h-8 rounded-md bg-zinc-700 dark:bg-zinc-300 flex items-center justify-center text-white dark:text-zinc-900 font-bold text-xs shadow-sm transition-colors hover:bg-zinc-600 dark:hover:bg-zinc-400 cursor-pointer"
              title="Workspace Settings"
            >
              {currentWorkspace?.name?.[0]?.toUpperCase()}
            </button>
          ) : (
            <div className="w-8 h-8 rounded-md bg-zinc-700 dark:bg-zinc-300 flex items-center justify-center text-white dark:text-zinc-900 font-bold text-xs shadow-sm transition-colors">
              <Briefcase size={16} />
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-col items-center gap-4 w-full pb-2">
            <ThemeToggle />
          <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden ring-1 ring-zinc-200 dark:ring-zinc-700">
             {session?.user?.image ? (
               <img src={session.user.image} alt={session.user.name || "User"} className="w-full h-full object-cover" />
             ) : (
               <div className="w-full h-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800">
                 <User size={16} />
               </div>
             )}
          </div>
          
          <button 
             onClick={handleSignOut}
             className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
             title="Sign Out"
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>

      <div 
        className={clsx(
          "absolute inset-0 flex flex-col transition-all duration-300 w-64",
          collapsed ? "opacity-0 translate-x-8 pointer-events-none" : "opacity-100 translate-x-0 pointer-events-auto"
        )}
      >
        <div className="relative z-[80] h-16 px-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 bg-zinc-50/50 dark:bg-zinc-900/50 backdrop-blur-sm">
          <div className="flex-1 min-w-0 relative">
            {isLoadingWorkspaces ? (
              <div className="h-9 w-full bg-zinc-200 dark:bg-zinc-800 animate-pulse rounded" />
            ) : (
              <WorkspaceSelector onCreateWorkspace={() => setShowCreateModal(true)} />
            )}
          </div>
          
          <button 
            onClick={onToggleCollapsed}
            className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Collapse Sidebar"
          >
            <PanelLeftClose size={18} />
          </button>
          
          {workspaceSlug && (
            <button 
              onClick={() => navigate(`/app/${workspaceSlug}/settings`)}
              className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              title="Workspace Settings"
            >
              <Settings size={18} />
            </button>
          )}
        </div>
        
        <div className="relative z-0 flex-1 overflow-hidden flex flex-col bg-zinc-50/30 dark:bg-zinc-900/30">
          {currentWorkspace && workspaceSlug ? (
            <PageTree workspaceId={currentWorkspace.id} workspaceSlug={workspaceSlug} />
          ) : (
            !isLoadingWorkspaces && (
              <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
                <Briefcase className="text-zinc-300 dark:text-zinc-600 mb-2" size={32} />
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Select a workspace to view pages
                </p>
              </div>
            )
          )}
        </div>

        <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          {currentWorkspace && (
            <button
              onClick={() => setShowTrashModal(true)}
              className="w-full flex items-center justify-between p-2 mb-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <Trash2 size={16} />
                <span className="text-sm font-medium">Trash</span>
              </div>
              {trashPages && trashPages.length > 0 && (
                <span className="px-1.5 py-0.5 text-xs font-medium bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-full">
                  {trashPages.length}
                </span>
              )}
            </button>
          )}
            <div className="mb-2 flex justify-end">
              <ThemeToggle />
            </div>
          <div className="flex items-center gap-3 p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group cursor-pointer">
            <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden flex-shrink-0 border border-zinc-200 dark:border-zinc-700">
               {session?.user?.image ? (
                 <img src={session.user.image} alt={session.user.name || "User"} className="w-full h-full object-cover" />
               ) : (
                 <div className="w-full h-full flex items-center justify-center text-zinc-400">
                   <User size={16} />
                 </div>
               )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {session?.user?.name || 'User'}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                {session?.user?.email}
              </div>
            </div>
            <button 
               onClick={handleSignOut}
               className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
               title="Sign Out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
      )}
      {showTrashModal && currentWorkspace && (
        <TrashView workspaceId={currentWorkspace.id} onClose={() => setShowTrashModal(false)} />
      )}
    </aside>
  );
}
