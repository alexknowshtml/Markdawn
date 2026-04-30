import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTheme } from './useTheme';

interface UseKeyboardShortcutsOptions {
  toggleSidebar: () => void;
}

export function useKeyboardShortcuts({ toggleSidebar }: UseKeyboardShortcutsOptions) {
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  const { setTheme, isDark } = useTheme();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName.toLowerCase();
      const isContentEditable = activeElement?.getAttribute('contenteditable') === 'true';
      
      if (tagName === 'input' || tagName === 'textarea' || isContentEditable) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifierKey = isMac ? event.metaKey : event.ctrlKey;

      if (modifierKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (workspaceSlug) {
          window.dispatchEvent(new CustomEvent('markdawn:create-note', {
            detail: { workspaceSlug }
          }));
        }
        return;
      }

      if (modifierKey && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (workspaceSlug) {
          window.dispatchEvent(new CustomEvent('markdawn:create-folder', {
            detail: { workspaceSlug }
          }));
        }
        return;
      }

      if (modifierKey && event.key === '/') {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if (modifierKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setTheme(isDark ? 'light' : 'dark');
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [workspaceSlug, toggleSidebar, setTheme, isDark]);
}
