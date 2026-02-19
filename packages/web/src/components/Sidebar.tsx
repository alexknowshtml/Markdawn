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
import { authClient } from "../lib/auth-client";
import { useWorkspaces } from '../hooks/use-workspaces';
import { PageTree } from './sidebar/PageTree';
import { useAuth } from '../hooks/useAuth';

export function Sidebar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  
  const { data: session } = useAuth();
  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces();
  
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

  const handleWorkspaceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSlug = e.target.value;
    if (newSlug) {
      navigate(`/app/${newSlug}`);
    }
  };

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
          "border-r border-zinc-200 bg-zinc-50 h-full flex flex-col items-center py-4 w-14 transition-all duration-300 flex-shrink-0 z-50",
          className
        )}
        data-testid="sidebar-collapsed"
      >
        <button 
          onClick={() => setCollapsed(false)}
          className="p-2 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-200 mb-6"
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
          <div className="w-8 h-8 rounded-full bg-zinc-200 overflow-hidden ring-1 ring-zinc-200">
             {session?.user?.image ? (
               <img src={session.user.image} alt={session.user.name || "User"} className="w-full h-full object-cover" />
             ) : (
               <div className="w-full h-full flex items-center justify-center text-zinc-500 bg-zinc-100">
                 <User size={16} />
               </div>
             )}
          </div>
          
          <button 
             onClick={handleSignOut}
             className="p-2 text-zinc-400 hover:text-red-600 rounded-md hover:bg-zinc-200 transition-colors"
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
        "w-64 border-r border-zinc-200 bg-zinc-50 h-full flex flex-col transition-all duration-300 flex-shrink-0 z-50",
        className
      )}
      data-testid="sidebar"
    >
      <div className="h-14 px-3 border-b border-zinc-200 flex items-center gap-2 bg-zinc-50/50 backdrop-blur-sm">
        <div className="flex-1 min-w-0 relative">
          {isLoadingWorkspaces ? (
            <div className="h-8 w-full bg-zinc-200 animate-pulse rounded" />
          ) : (
            <div className="relative">
              <select
                value={workspaceSlug || ''}
                onChange={handleWorkspaceChange}
                className="w-full h-8 pl-2 pr-8 text-sm font-semibold text-zinc-800 bg-transparent hover:bg-zinc-200/50 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 appearance-none cursor-pointer truncate transition-colors"
              >
                <option value="" disabled>Select Workspace</option>
                {workspaces?.map((w) => (
                  <option key={w.id} value={w.slug}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500">
                <Briefcase size={14} />
              </div>
            </div>
          )}
        </div>
        
        <button 
          onClick={() => setCollapsed(true)}
          className="p-1.5 text-zinc-400 hover:text-zinc-600 rounded-md hover:bg-zinc-200 transition-colors"
          title="Collapse Sidebar"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col bg-zinc-50/30">
        {currentWorkspace && workspaceSlug ? (
          <PageTree workspaceId={currentWorkspace.id} workspaceSlug={workspaceSlug} />
        ) : (
          !isLoadingWorkspaces && (
            <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
              <Briefcase className="text-zinc-300 mb-2" size={32} />
              <p className="text-sm text-zinc-500">
                Select a workspace to view pages
              </p>
            </div>
          )
        )}
      </div>

      <div className="p-3 border-t border-zinc-200 bg-white">
        <div className="flex items-center gap-3 p-1 rounded-lg hover:bg-zinc-100 transition-colors group">
          <div className="w-8 h-8 rounded-full bg-zinc-100 overflow-hidden flex-shrink-0 border border-zinc-200">
             {session?.user?.image ? (
               <img src={session.user.image} alt={session.user.name || "User"} className="w-full h-full object-cover" />
             ) : (
               <div className="w-full h-full flex items-center justify-center text-zinc-400">
                 <User size={16} />
               </div>
             )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-900 truncate">
              {session?.user?.name || 'User'}
            </div>
            <div className="text-xs text-zinc-500 truncate">
              {session?.user?.email}
            </div>
          </div>
          <button 
             onClick={handleSignOut}
             className="p-1.5 text-zinc-400 hover:text-red-600 rounded hover:bg-zinc-200 transition-colors opacity-0 group-hover:opacity-100"
             title="Sign Out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
