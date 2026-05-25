import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToolbarState {
  visible: boolean;
  position: { top: number; left: number };
}

export interface FloatingToolbarApi {
  visible: boolean;
  position: { top: number; left: number };
  keepVisible: () => void;
  reposition: () => void;
}

function computePosition(): { top: number; left: number } {
  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    return { top: 0, left: 0 };
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return {
    top: rect.top - 50,
    left: rect.left + rect.width / 2 + 20,
  };
}

export function useFloatingToolbar(): FloatingToolbarApi {
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

  const reposition = useCallback(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return;
    }
    const container = document.querySelector('.milkdown-editor');
    if (!container?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      return;
    }
    setToolbarState({
      visible: true,
      position: computePosition(),
    });
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

        if (!container?.contains(range.commonAncestorContainer)) {
          setToolbarState((prev) => ({ ...prev, visible: false }));
          return;
        }

        setToolbarState({
          visible: true,
          position: computePosition(),
        });
      }, 100);
    };

    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearTimeout(timeoutId);
    };
  }, []);

  return { ...toolbarState, keepVisible, reposition };
}
