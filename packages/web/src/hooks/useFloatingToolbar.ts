import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToolbarState {
  visible: boolean;
  position: { top: number; left: number };
}

export function useFloatingToolbar() {
  const [toolbarState, setToolbarState] = useState<ToolbarState>({
    visible: false,
    position: { top: 0, left: 0 },
  });

  const keepVisibleRef = useRef(false);

  const keepVisible = useCallback(() => {
    keepVisibleRef.current = true;
    setToolbarState((prev) => ({ ...prev, visible: true }));
    setTimeout(() => {
      keepVisibleRef.current = false;
    }, 300);
  }, []);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const handleSelectionChange = () => {
      timeoutId = setTimeout(() => {
        if (keepVisibleRef.current) return;

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
          setToolbarState((prev) => ({ ...prev, visible: false }));
          return;
        }

        const range = selection.getRangeAt(0);
        const container = document.querySelector('.milkdown-editor');

        if (!container || !container.contains(range.commonAncestorContainer)) {
          setToolbarState((prev) => ({ ...prev, visible: false }));
          return;
        }

        const rect = range.getBoundingClientRect();

        setToolbarState({
          visible: true,
          position: {
            top: rect.top - 50,
            left: rect.left + rect.width / 2 + 20,
          },
        });
      }, 100);
    };

    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearTimeout(timeoutId);
    };
  }, []);

  return { ...toolbarState, keepVisible };
}
