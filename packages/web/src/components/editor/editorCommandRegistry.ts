import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconH4,
  IconH5,
  IconH6,
  IconItalic,
  IconLink,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconPhoto,
  IconStrikethrough,
  IconTable,
} from '@tabler/icons-react';
import { createElement, type ReactNode } from 'react';
import type { EditorFormattingCommands } from './editorFormattingCommands';
import type { EditorTableCommands } from './editorTableCommands';

type EditorCommandActions = EditorFormattingCommands & EditorTableCommands;

export type EditorCommandId =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'blockquote'
  | 'link'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'table'
  | 'image'
  | 'divider'
  | 'tag'
  | 'add-row-before'
  | 'add-row-after'
  | 'add-column-before'
  | 'add-column-after'
  | 'delete-row'
  | 'delete-column'
  | 'delete-table';

export type EditorCommand = {
  id: EditorCommandId;
  label: string;
  hint: string;
  keywords: string[];
  icon: ReactNode;
  shortcut?: string;
  shortcutKeys: string[];
  requiresSelection?: boolean;
  showInSlashMenu: boolean;
  available: boolean;
  execute(): void;
};

export type EditorCommandRegistry = {
  all: EditorCommand[];
  command(id: EditorCommandId): EditorCommand;
};

type CommandDefinition = Omit<EditorCommand, 'available' | 'execute' | 'showInSlashMenu'> & {
  showInSlashMenu?: boolean;
  run(actions: EditorCommandActions): void;
};

const definitions: CommandDefinition[] = [
  {
    id: 'paragraph',
    label: 'Paragraph',
    hint: 'P',
    shortcut: 'Ctrl+Alt+0',
    shortcutKeys: ['mod+alt+0'],
    keywords: ['paragraph', 'text', 'p'],
    icon: createElement('span', { className: 'text-xs' }, '¶'),
    run: (actions) => actions.runBlockCommand('paragraph'),
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => {
    const icons = { 1: IconH1, 2: IconH2, 3: IconH3, 4: IconH4, 5: IconH5, 6: IconH6 };
    const handlers = {
      1: 'handleH1',
      2: 'handleH2',
      3: 'handleH3',
      4: 'handleH4',
      5: 'handleH5',
      6: 'handleH6',
    } as const;
    return {
      id: `h${level}` as EditorCommandId,
      label: `Heading ${level}`,
      hint: `H${level}`,
      shortcut: `Ctrl+Alt+${level}`,
      shortcutKeys: [`mod+alt+${level}`],
      keywords: ['heading', `h${level}`, ...(level === 1 ? ['title'] : [])],
      icon: createElement(icons[level], { size: 16 }),
      run: (actions: EditorCommandActions) => actions[handlers[level]](),
    };
  }),
  {
    id: 'bold',
    label: 'Bold',
    hint: 'Bold',
    shortcut: 'Ctrl+B',
    shortcutKeys: ['mod+b'],
    keywords: ['bold', 'strong'],
    icon: createElement(IconBold, { size: 16 }),
    run: (actions) => actions.handleBold(),
  },
  {
    id: 'italic',
    label: 'Italic',
    hint: 'Italic',
    shortcut: 'Ctrl+I',
    shortcutKeys: ['mod+i'],
    keywords: ['italic', 'emphasis'],
    icon: createElement(IconItalic, { size: 16 }),
    run: (actions) => actions.handleItalic(),
  },
  {
    id: 'strikethrough',
    label: 'Strikethrough',
    hint: 'Strike',
    shortcut: 'Ctrl+Shift+X',
    shortcutKeys: ['mod+shift+x'],
    keywords: ['strikethrough', 'strike'],
    icon: createElement(IconStrikethrough, { size: 16 }),
    run: (actions) => actions.handleStrike(),
  },
  {
    id: 'code',
    label: 'Code',
    hint: 'Code',
    shortcut: 'Ctrl+`',
    shortcutKeys: ['mod+`'],
    keywords: ['code', 'inline'],
    icon: createElement(IconCode, { size: 16 }),
    run: (actions) => actions.handleCode(),
  },
  {
    id: 'blockquote',
    label: 'Blockquote',
    hint: 'Quote',
    shortcut: 'Ctrl+Shift+>',
    shortcutKeys: ['mod+shift+>'],
    keywords: ['quote', 'blockquote', 'citation'],
    icon: createElement(IconBlockquote, { size: 16 }),
    run: (actions) => actions.handleBlockquote(),
  },
  {
    id: 'link',
    label: 'Link',
    hint: 'Link',
    shortcut: 'Ctrl+K',
    shortcutKeys: ['mod+k'],
    requiresSelection: true,
    keywords: ['link', 'url'],
    icon: createElement(IconLink, { size: 16 }),
    run: (actions) => actions.handleLink(),
  },
  {
    id: 'bullet-list',
    label: 'Bullet List',
    hint: 'Bullet',
    shortcut: 'Ctrl+Shift+8',
    shortcutKeys: ['mod+shift+8', 'mod+shift+*'],
    keywords: ['bullet', 'list', 'unordered'],
    icon: createElement(IconList, { size: 16 }),
    run: (actions) => actions.handleBulletList(),
  },
  {
    id: 'ordered-list',
    label: 'Ordered List',
    hint: 'Ordered',
    shortcut: 'Ctrl+Shift+7',
    shortcutKeys: ['mod+shift+7', 'mod+shift+&'],
    keywords: ['ordered', 'list', 'number', 'numbered'],
    icon: createElement(IconListNumbers, { size: 16 }),
    run: (actions) => actions.handleOrderedList(),
  },
  {
    id: 'task-list',
    label: 'Task List',
    hint: 'Check',
    shortcut: 'Ctrl+Shift+[',
    shortcutKeys: ['mod+shift+[', 'mod+shift+{'],
    keywords: ['task', 'check', 'list', 'todo', 'checkbox'],
    icon: createElement(IconListCheck, { size: 16 }),
    run: (actions) => actions.handleTaskList(),
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Table',
    shortcutKeys: [],
    keywords: ['table', 'grid'],
    icon: createElement(IconTable, { size: 16 }),
    run: (actions) => actions.handleInsertTable(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'Img',
    shortcut: 'Ctrl+Shift+I',
    shortcutKeys: ['mod+shift+i'],
    keywords: ['image', 'photo', 'upload'],
    icon: createElement(IconPhoto, { size: 16 }),
    run: (actions) => actions.handleImageUploadFromSlash(),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Line',
    shortcutKeys: [],
    keywords: ['divider', 'hr', 'line', 'separator', 'horizontal rule'],
    icon: createElement('span', { className: 'text-lg' }, '—'),
    run: (actions) => actions.handleInsertDivider(),
  },
  {
    id: 'tag',
    label: 'Tag',
    hint: 'Tag',
    shortcut: 'Ctrl+Shift+#',
    shortcutKeys: ['mod+shift+#'],
    keywords: ['tag', 'label', 'property', '#'],
    icon: createElement('span', { className: 'text-sm' }, '#'),
    run: (actions) => actions.handleInsertTag(),
  },
  {
    id: 'add-row-before',
    label: 'Add row before',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleAddRowBefore(),
  },
  {
    id: 'add-row-after',
    label: 'Add row after',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleAddRowAfter(),
  },
  {
    id: 'add-column-before',
    label: 'Add column before',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleAddColBefore(),
  },
  {
    id: 'add-column-after',
    label: 'Add column after',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleAddColAfter(),
  },
  {
    id: 'delete-row',
    label: 'Delete row',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleDeleteRow(),
  },
  {
    id: 'delete-column',
    label: 'Delete column',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleDeleteCol(),
  },
  {
    id: 'delete-table',
    label: 'Delete table',
    hint: '',
    shortcutKeys: [],
    keywords: [],
    icon: null,
    showInSlashMenu: false,
    run: (actions) => actions.handleDeleteTable(),
  },
];

export function createEditorCommandRegistry(
  actions: EditorCommandActions,
  canUploadImages: boolean,
): EditorCommandRegistry {
  const all = definitions.map((definition) => ({
    ...definition,
    available: definition.id !== 'image' || canUploadImages,
    showInSlashMenu: definition.showInSlashMenu ?? true,
    execute: () => definition.run(actions),
  }));
  return {
    all,
    command: (id) => {
      const command = all.find((candidate) => candidate.id === id);
      if (!command) throw new Error(`Unknown editor command: ${id}`);
      return command;
    },
  };
}
