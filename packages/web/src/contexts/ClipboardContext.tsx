import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

export type ClipboardItem = {
  id: string;
  type: 'page' | 'folder';
};

export type ClipboardState = {
  action: 'copy' | 'cut' | null;
  items: ClipboardItem[];
};

interface ClipboardContextType {
  state: ClipboardState;
  copy: (items: ClipboardItem[]) => void;
  cut: (items: ClipboardItem[]) => void;
  clear: () => void;
  isInClipboard: (id: string) => boolean;
}

const ClipboardContext = createContext<ClipboardContextType | undefined>(undefined);

export function ClipboardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ClipboardState>({
    action: null,
    items: [],
  });

  const copy = useCallback((items: ClipboardItem[]) => {
    setState({ action: 'copy', items });
  }, []);

  const cut = useCallback((items: ClipboardItem[]) => {
    setState({ action: 'cut', items });
  }, []);

  const clear = useCallback(() => {
    setState({ action: null, items: [] });
  }, []);

  const isInClipboard = useCallback(
    (id: string) => state.items.some((item) => item.id === id),
    [state.items],
  );

  return (
    <ClipboardContext.Provider value={{ state, copy, cut, clear, isInClipboard }}>
      {children}
    </ClipboardContext.Provider>
  );
}

export function useClipboard() {
  const context = useContext(ClipboardContext);
  if (context === undefined) {
    throw new Error('useClipboard must be used within a ClipboardProvider');
  }
  return context;
}
