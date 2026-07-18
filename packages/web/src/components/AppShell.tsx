import clsx from 'clsx';
import { Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useShortcut } from '../contexts/KeyboardShortcutContext';
import { useShareContext } from '../contexts/ShareContext';
import { usePageMeta } from '../hooks/usePageMeta';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';
import { useTheme } from '../hooks/useTheme';
import { CommandPalette } from './CommandPalette';
import { ProfilePill } from './ProfilePill';
import { Sidebar } from './Sidebar';

export function AppShell() {
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();
  const [isHovered, setIsHovered] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { setTheme, isDark } = useTheme();
  const location = useLocation();
  const { isAnonymous } = useShareContext();

  useShortcut({
    key: 'mod+/',
    handler: toggleCollapsed,
    whenInputFocused: 'allow',
    description: 'Toggle sidebar',
  });
  const createNote = () => {
    window.dispatchEvent(new CustomEvent('markdawn:create-note'));
  };
  const createFolder = () => {
    window.dispatchEvent(new CustomEvent('markdawn:create-folder'));
  };
  useShortcut({
    key: 'alt+n',
    handler: createNote,
    whenInputFocused: 'allow',
    description: 'Create new note',
  });
  useShortcut({
    key: 'alt+shift+n',
    handler: createFolder,
    whenInputFocused: 'allow',
    description: 'Create new folder',
  });
  useShortcut({
    key: 'mod+shift+d',
    handler: () => setTheme(isDark ? 'light' : 'dark'),
    whenInputFocused: 'allow',
    description: 'Toggle dark mode',
  });

  usePageMeta();

  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname triggers mobile menu close on navigation
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full bg-zinc-50 dark:bg-zinc-950 overflow-hidden text-zinc-900 dark:text-zinc-50 font-sans">
      {!isAnonymous && (
        <>
          {/* Layout Spacer - ensures center content animates smoothly when sidebar is pinned/unpinned */}
          <div
            className={clsx(
              'hidden md:block transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] flex-shrink-0 overflow-hidden',
              collapsed ? 'w-0' : 'w-[252px]',
            )}
          />

          {/* Visual Sidebar - handles the slide/fade animation and hover overlay */}
          <section
            aria-label="Sidebar"
            className={clsx(
              'hidden md:flex flex-col flex-shrink-0 items-center pl-3 py-3 gap-3 h-screen transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] z-40 w-[252px] fixed left-0',
              collapsed
                ? isHovered
                  ? 'opacity-100 translate-x-0 bg-zinc-50/80 dark:bg-zinc-950/80 backdrop-blur-xl pointer-events-auto'
                  : 'opacity-0 -translate-x-full pointer-events-none'
                : 'opacity-100 translate-x-0 pointer-events-auto',
            )}
            onMouseLeave={() => collapsed && setIsHovered(false)}
          >
            <Sidebar
              className="flex-1 w-full"
              collapsed={collapsed && !isHovered}
              onToggleCollapsed={toggleCollapsed}
            />
            <ProfilePill
              collapsed={collapsed && !isHovered}
              isActuallyCollapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              className="flex-shrink-0"
            />
          </section>

          {collapsed && !isHovered && (
            <button
              type="button"
              className="hidden md:block fixed left-0 top-0 bottom-0 w-16 z-50 bg-transparent border-none p-0 cursor-pointer"
              onMouseEnter={() => setIsHovered(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setIsHovered(true);
                }
              }}
              aria-label="Show sidebar"
            />
          )}
        </>
      )}

      {!isAnonymous && isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <button
            type="button"
            className="fixed inset-0 bg-zinc-900/50 backdrop-blur-sm animate-fade-in border-none p-0 cursor-pointer"
            onClick={() => setIsMobileMenuOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setIsMobileMenuOpen(false);
            }}
            aria-label="Close menu"
          />
          <div className="relative flex w-auto max-w-[80%] flex-col p-3 gap-3 animate-slide-right h-[100vh]">
            <Sidebar
              className="flex-1 w-full"
              collapsed={false}
              onToggleCollapsed={() => setIsMobileMenuOpen(false)}
            />
            <ProfilePill
              collapsed={false}
              onToggleCollapsed={() => setIsMobileMenuOpen(false)}
              className="flex-shrink-0"
            />
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col h-full overflow-hidden relative">
        {!isAnonymous && (
          <div className="md:hidden flex items-center h-14 px-4 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-xl flex-shrink-0 z-10 sticky top-0">
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(true)}
              className="p-2 -ml-2 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
          </div>
        )}

        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth pb-8">
          <div className="mx-auto min-h-full w-full min-w-0 max-w-4xl p-6 md:p-12 animate-fade-in">
            <Outlet />
          </div>
        </div>
        {!isAnonymous && <CommandPalette />}
      </main>
    </div>
  );
}
