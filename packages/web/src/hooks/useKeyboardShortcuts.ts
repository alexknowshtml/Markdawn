import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCreatePage } from './use-pages';
import { useWorkspaces } from './use-workspaces';
import { useTheme } from './useTheme';

interface UseKeyboardShortcutsOptions {
  toggleSidebar: () => void;
}

export function useKeyboardShortcuts({ toggleSidebar }: UseKeyboardShortcutsOptions) {
  const navigate = useNavigate();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;
  
  const { data: workspaces } = useWorkspaces();
  const createPageMutation = useCreatePage();
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
          const currentWorkspace = workspaces?.find(w => w.slug === workspaceSlug);
          if (currentWorkspace) {
            createPageMutation.mutateAsync(
              { workspaceId: currentWorkspace.id },
              { onSuccess: (newPage) => {
                navigate(`/app/${workspaceSlug}/${newPage.id}`);
              }}
            );
          }
        }
        return;
      }

      if (modifierKey && event.key === '\\') {
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
  }, [workspaceSlug, workspaces, createPageMutation, navigate, toggleSidebar, setTheme, isDark]);
}
