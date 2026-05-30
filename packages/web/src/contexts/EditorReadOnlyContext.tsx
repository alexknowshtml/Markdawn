import { createContext, type ReactNode, useContext } from 'react';

const EditorReadOnlyContext = createContext(false);

interface EditorReadOnlyProviderProps {
  readOnly: boolean;
  children: ReactNode;
}

export function EditorReadOnlyProvider({ readOnly, children }: EditorReadOnlyProviderProps) {
  return (
    <EditorReadOnlyContext.Provider value={readOnly}>{children}</EditorReadOnlyContext.Provider>
  );
}

export function useIsReadOnly(): boolean {
  return useContext(EditorReadOnlyContext);
}
