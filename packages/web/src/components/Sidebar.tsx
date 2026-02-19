import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { 
  LogOut, 
  User,
  PanelLeftClose,
  PanelLeftOpen,
  Briefcase
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { authClient } from "../lib/auth-client";
import { useWorkspaces } from '../hooks/use-workspaces';
import { PageTree } from './sidebar/PageTree';
import { useAuth } from '../hooks/useAuth';
import { WorkspaceSelector } from './workspace/WorkspaceSelector';
import { CreateWorkspaceModal } from './workspace/CreateWorkspaceModal';

export function Sidebar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  
  const { data: session } = useAuth();
  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces();
  const [showCreateModal, setShowCreateModal] = useState(false);
  
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('markdawn-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem('markdawn-sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const currentWorkspace = workspaces?.find(w => w.slug === workspaceSlug);


  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          navigate('/login');
        },
      },
    });
  };

  if (collapsed) {
    return (
      <aside 
        className={clsx(
          "border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 h-full flex flex-col items-center py-4 w-14 transition-all duration-300 flex-shrink-0 z-50",
          className
        )}
        data-testid="sidebar-collapsed"
      >
        <button 
          onClick={() => setCollapsed(false)}
          className="p-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 mb-6"
          title="Expand Sidebar"
        >
          <PanelLeftOpen size={20} />
        </button>
        
        <div className="flex-1 flex flex-col items-center gap-4 w-full">
          <div className="w-8 h-8 rounded-md bg-blue-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
            {currentWorkspace?.name?.[0]?.toUpperCase() || <Briefcase size={16} />}
          </div>
        </div>

        <div className="mt-auto flex flex-col items-center gap-4 w-full pb-2">
            <ThemeToggle />
          <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden ring-1 ring-zinc-200 dark:ring-zinc-700">
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
             className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
             title="Sign Out"
          >
            <LogOut size={20} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside 
      className={clsx(
        "w-64 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 h-full flex flex-col transition-all duration-300 flex-shrink-0 z-50",
        className
      )}
      data-testid="sidebar"
    >
      <div className="h-16 px-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 bg-zinc-50/50 dark:bg-zinc-900/50 backdrop-blur-sm">
        <div className="flex-1 min-w-0 relative">
          {isLoadingWorkspaces ? (
            <div className="h-9 w-full bg-zinc-200 dark:bg-zinc-800 animate-pulse rounded" />
          ) : (
            <WorkspaceSelector onCreateWorkspace={() => setShowCreateModal(true)} />
          )}
        </div>
        
        <button 
          onClick={() => setCollapsed(true)}
          className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
          title="Collapse Sidebar"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col bg-zinc-50/30 dark:bg-zinc-900/30">
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
          <div className="mb-2 flex justify-end">
            <ThemeToggle />
          </div>
        <div className="flex items-center gap-3 p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group">
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
             className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100"
             title="Sign Out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
      {showCreateModal && (
        <CreateWorkspaceModal onClose={() => setShowCreateModal(false)} />
      )}
    </aside>
  );
}
