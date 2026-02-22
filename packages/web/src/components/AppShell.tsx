import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useWorkspaces } from '../hooks/use-workspaces';
import { Menu } from 'lucide-react';

export function AppShell() {
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const location = useLocation();
  const { data: workspaces } = useWorkspaces();
  const workspaceSlug = location.pathname.split('/')[2] ?? '';
  const workspace = workspaces?.find((item) => item.slug === workspaceSlug);
  
  useKeyboardShortcuts({ toggleSidebar: toggleCollapsed });

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full bg-white dark:bg-zinc-950 overflow-hidden text-zinc-900 dark:text-zinc-50 font-sans">
      <Sidebar className="hidden md:flex flex-shrink-0" collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div 
            className="fixed inset-0 bg-zinc-900/50 backdrop-blur-sm animate-fade-in"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <div className="relative flex w-64 max-w-[80%] flex-col bg-white dark:bg-zinc-950 shadow-2xl animate-slide-right">
            <Sidebar className="flex !w-full h-full" collapsed={false} onToggleCollapsed={() => setIsMobileMenuOpen(false)} />
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <div className="md:hidden flex items-center h-14 px-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex-shrink-0">
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-2 -ml-2 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto bg-white dark:bg-zinc-950 scroll-smooth">
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
