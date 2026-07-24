import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

const EditorReadOnlyContext = createContext(false);
const SetEditorReadOnlyContext = createContext<React.Dispatch<React.SetStateAction<boolean>>>(
  () => {},
);

interface EditorReadOnlyProviderProps {
  readOnly: boolean;
  children: ReactNode;
}

export function EditorReadOnlyProvider({
  readOnly: initial,
  children,
}: EditorReadOnlyProviderProps) {
  const [readOnly, setReadOnly] = useState(initial);

  useEffect(() => {
    setReadOnly(initial);
  }, [initial]);

  return (
    <SetEditorReadOnlyContext.Provider value={setReadOnly}>
      <EditorReadOnlyContext.Provider value={readOnly}>{children}</EditorReadOnlyContext.Provider>
    </SetEditorReadOnlyContext.Provider>
  );
}

export function useIsReadOnly(): boolean {
  return useContext(EditorReadOnlyContext);
}

export function useSetReadOnly(): React.Dispatch<React.SetStateAction<boolean>> {
  return useContext(SetEditorReadOnlyContext);
}
