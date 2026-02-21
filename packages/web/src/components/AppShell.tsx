import React from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SearchDialog } from './search/SearchDialog';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

export function AppShell() {
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();
  
  useKeyboardShortcuts({ toggleSidebar: toggleCollapsed });

  return (
    <div className="flex h-screen w-full bg-white dark:bg-zinc-950 overflow-hidden text-zinc-900 dark:text-zinc-50 font-sans">
      <Sidebar className="hidden md:flex flex-shrink-0" collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        
        <div className="flex-1 overflow-y-auto bg-white dark:bg-zinc-950 scroll-smooth">
          <div className="max-w-4xl mx-auto w-full p-6 md:p-12 min-h-full animate-fade-in">
            <Outlet />
          </div>
        </div>
        <SearchDialog />
      </main>
    </div>
  );
}
