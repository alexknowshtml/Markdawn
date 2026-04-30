import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ProfilePill } from './ProfilePill';
import { WorkspacePill } from './workspace/WorkspacePill';
import { CommandPalette } from './CommandPalette';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useWorkspaces } from '../hooks/use-workspaces';
import { Menu } from 'lucide-react';

export function AppShell() {
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const location = useLocation();
  const { data: workspaces } = useWorkspaces();
  const workspaceSlug = location.pathname.split('/')[2] ?? '';
  const workspace = workspaces?.find((item) => item.slug === workspaceSlug);
  
  useKeyboardShortcuts({ toggleSidebar: toggleCollapsed });

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full bg-zinc-50 dark:bg-zinc-950 overflow-hidden text-zinc-900 dark:text-zinc-50 font-sans">
      <div className="hidden md:flex flex-col flex-shrink-0 items-center pl-3 py-3 gap-3 h-[100vh]">
        <WorkspacePill 
          collapsed={collapsed} 
          onToggleCollapsed={toggleCollapsed}
          onCreateWorkspace={() => setShowCreateWorkspace(true)}
          className="flex-shrink-0" 
        />
        <Sidebar className="flex-1 w-full" collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        <ProfilePill collapsed={collapsed} onToggleCollapsed={toggleCollapsed} className="flex-shrink-0" />
      </div>
      
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div 
            className="fixed inset-0 bg-zinc-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <div className="relative flex w-auto max-w-[80%] flex-col p-3 gap-3 animate-slide-right h-[100vh]">
            <WorkspacePill 
              collapsed={false}
              onToggleCollapsed={() => setIsMobileMenuOpen(false)}
              onCreateWorkspace={() => {
                setIsMobileMenuOpen(false);
                setShowCreateWorkspace(true);
              }}
              className="flex-shrink-0"
            />
            <Sidebar className="flex-1 w-full" collapsed={false} onToggleCollapsed={() => setIsMobileMenuOpen(false)} />
            <ProfilePill collapsed={false} onToggleCollapsed={() => setIsMobileMenuOpen(false)} className="flex-shrink-0" />
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <div className="md:hidden flex items-center h-14 px-4 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-xl flex-shrink-0 z-10 sticky top-0">
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-2 -ml-2 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto scroll-smooth pb-8">
          <div className="max-w-4xl mx-auto w-full p-6 md:p-12 min-h-full animate-fade-in">
            <Outlet />
          </div>
        </div>
        {workspace && (
          <CommandPalette workspaceId={workspace.id} workspaceSlug={workspace.slug} />
        )}
      </main>
    </div>
  );
}
