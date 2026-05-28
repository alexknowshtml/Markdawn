import type { ReactNode } from 'react';
import { ClipboardProvider } from '../contexts/ClipboardContext';
import { KeyboardShortcutProvider } from '../contexts/KeyboardShortcutContext';
import { SelectionProvider } from '../contexts/SelectionContext';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClipboardProvider>
      <SelectionProvider>
        <KeyboardShortcutProvider>{children}</KeyboardShortcutProvider>
      </SelectionProvider>
    </ClipboardProvider>
  );
}
