import type { Editor } from '@milkdown/core';
import { editorViewCtx } from '@milkdown/core';
import { type ShortcutDefinition, useShortcuts } from '../../contexts/KeyboardShortcutContext';
import type { EditorCommand, EditorCommandRegistry } from './editorCommandRegistry';

export function useEditorShortcuts(
  editor: Editor | null,
  isReadOnly: boolean,
  commands: EditorCommandRegistry,
): void {
  const editorHasFocus = (): boolean => {
    if (!editor) return false;
    let focused = false;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view) focused = view.hasFocus();
      });
    } catch {
      // The editor may have been destroyed while a shortcut event was queued.
    }
    return focused;
  };
  const editorAction = (command: EditorCommand) => (): boolean => {
    if (isReadOnly || !editorHasFocus()) return false;
    if (command.requiresSelection) {
      let hasSelection = false;
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        hasSelection = view?.state.selection.from !== view?.state.selection.to;
      });
      if (!hasSelection) return false;
    }
    command.execute();
    return true;
  };
  const shortcuts: ShortcutDefinition[] = commands.all.flatMap((command) =>
    command.available
      ? command.shortcutKeys.map((key, index) => ({
          key,
          handler: editorAction(command),
          scope: 'editor',
          ...(command.id === 'link' ? { priority: 'high' as const } : {}),
          description: index === 0 ? command.label : '',
        }))
      : [],
  );

  useShortcuts(shortcuts);
}
