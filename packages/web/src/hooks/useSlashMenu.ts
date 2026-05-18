import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { Editor } from '@milkdown/core';
import { insertTableCommand } from '@milkdown/preset-gfm';
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
import { setBlockType, wrapIn } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { type MutableRefObject, createElement, useCallback, useRef, useState } from 'react';

interface SlashMenuState {
  isOpen: boolean;
  query: string;
  position: { x: number; y: number; top?: number; bottom?: number } | null;
  range: { from: number; to: number } | null;
}

interface UseSlashMenuOptions {
  handleBold: () => void;
  handleItalic: () => void;
  handleStrike: () => void;
  handleCode: () => void;
  handleLink: () => void;
  handleImageUploadFromSlash: () => void;
}

export function useSlashMenu(
  editorRef: MutableRefObject<Editor | null>,
  {
    handleBold,
    handleItalic,
    handleStrike,
    handleCode,
    handleLink,
    handleImageUploadFromSlash,
  }: UseSlashMenuOptions,
) {
  const [slashMenuState, setSlashMenuState] = useState<SlashMenuState>({
    isOpen: false,
    query: '',
    position: null,
    range: null,
  });

  const rangeRef = useRef(slashMenuState.range);
  rangeRef.current = slashMenuState.range;

  const handleSlashMenuSuggest = useCallback(
    (
      isOpen: boolean,
      query: string,
      position: { x: number; y: number; top?: number; bottom?: number } | null,
      range: { from: number; to: number } | null,
    ) => {
      setSlashMenuState({ isOpen, query, position, range });
    },
    [],
  );

  const closeSlashMenu = useCallback(() => {
    setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleSlashParagraph = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const paraType = state.schema.nodes.paragraph;
      if (!paraType) return;
      const command = setBlockType(paraType as never);
      command(state, dispatch);
    });
  };

  const handleSlashHeading = (level: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const headingType = state.schema.nodes.heading;
      if (!headingType) return;
      const command = setBlockType(headingType as never, { level });
      command(state, dispatch);
    });
  };

  const handleSlashQuote = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const blockquoteType = state.schema.nodes.blockquote;
      if (!blockquoteType) return;
      const command = wrapIn(blockquoteType as never);
      command(state, dispatch);
    });
  };

  const handleSlashBulletList = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      if (!bulletListType) return;
      const command = wrapIn(bulletListType as never);
      command(state, dispatch);
    });
  };

  const handleSlashOrderedList = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const orderedListType = state.schema.nodes.ordered_list;
      if (!orderedListType) return;
      const command = wrapIn(orderedListType as never);
      command(state, dispatch);
    });
  };

  const handleSlashTaskList = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      const listItemType = state.schema.nodes.list_item;
      if (!bulletListType || !listItemType) return;

      const command = wrapIn(bulletListType as never);
      command(state, dispatch);

      const newState = view.state;
      const tr = newState.tr;
      const { from, to } = newState.selection;
      newState.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type === listItemType && node.attrs.checked == null) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
        }
      });
      if (tr.docChanged) {
        dispatch(tr);
      }
    });
  };

  const handleSlashInsertTable = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(insertTableCommand.key, { row: 3, col: 3 });
    });
  };

  const handleSlashDivider = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const hrType = state.schema.nodes.hr;
      if (!hrType) return;
      const { $from } = state.selection;
      const node = hrType.create();
      const tr = state.tr.insert($from.pos, node);
      dispatch(tr);
    });
  };

  const handleSlashTag = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const { $from } = state.selection;
      const tr = state.tr.insertText('#tag ', $from.pos);
      dispatch(tr);
    });
  };

  const removeSlashTrigger = () => {
    const range = rangeRef.current;
    const editor = editorRef.current;
    if (!editor || !range) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const { from, to } = range;
      const tr = state.tr.delete(from, to);
      const cursorPos = from;
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
      dispatch(tr);
    });
  };

  const executeSlashAction = (action: () => void) => {
    removeSlashTrigger();
    closeSlashMenu();
    setTimeout(() => {
      action();
      const editor = editorRef.current;
      if (editor) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (view) {
            view.focus();
          }
        });
      }
    }, 0);
  };

  const slashCommands = [
    {
      id: 'paragraph',
      label: 'Paragraph',
      hint: 'P',
      shortcut: 'Ctrl+Alt+0',
      keywords: ['paragraph', 'text', 'p'],
      icon: createElement('span', { className: 'text-xs' }, '\u00B6'),
      onSelect: () => executeSlashAction(handleSlashParagraph),
    },
    {
      id: 'h1',
      label: 'Heading 1',
      hint: 'H1',
      shortcut: 'Ctrl+Alt+1',
      keywords: ['heading', 'h1', 'title'],
      icon: createElement(IconH1, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(1)),
    },
    {
      id: 'h2',
      label: 'Heading 2',
      hint: 'H2',
      shortcut: 'Ctrl+Alt+2',
      keywords: ['heading', 'h2'],
      icon: createElement(IconH2, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(2)),
    },
    {
      id: 'h3',
      label: 'Heading 3',
      hint: 'H3',
      shortcut: 'Ctrl+Alt+3',
      keywords: ['heading', 'h3'],
      icon: createElement(IconH3, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(3)),
    },
    {
      id: 'h4',
      label: 'Heading 4',
      hint: 'H4',
      shortcut: 'Ctrl+Alt+4',
      keywords: ['heading', 'h4'],
      icon: createElement(IconH4, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(4)),
    },
    {
      id: 'h5',
      label: 'Heading 5',
      hint: 'H5',
      shortcut: 'Ctrl+Alt+5',
      keywords: ['heading', 'h5'],
      icon: createElement(IconH5, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(5)),
    },
    {
      id: 'h6',
      label: 'Heading 6',
      hint: 'H6',
      shortcut: 'Ctrl+Alt+6',
      keywords: ['heading', 'h6'],
      icon: createElement(IconH6, { size: 16 }),
      onSelect: () => executeSlashAction(() => handleSlashHeading(6)),
    },
    {
      id: 'bold',
      label: 'Bold',
      hint: 'Bold',
      shortcut: 'Ctrl+B',
      keywords: ['bold', 'strong'],
      icon: createElement(IconBold, { size: 16 }),
      onSelect: () => executeSlashAction(handleBold),
    },
    {
      id: 'italic',
      label: 'Italic',
      hint: 'Italic',
      shortcut: 'Ctrl+I',
      keywords: ['italic', 'emphasis'],
      icon: createElement(IconItalic, { size: 16 }),
      onSelect: () => executeSlashAction(handleItalic),
    },
    {
      id: 'strikethrough',
      label: 'Strikethrough',
      hint: 'Strike',
      shortcut: 'Ctrl+Shift+X',
      keywords: ['strikethrough', 'strike'],
      icon: createElement(IconStrikethrough, { size: 16 }),
      onSelect: () => executeSlashAction(handleStrike),
    },
    {
      id: 'code',
      label: 'Code',
      hint: 'Code',
      shortcut: 'Ctrl+`',
      keywords: ['code', 'inline'],
      icon: createElement(IconCode, { size: 16 }),
      onSelect: () => executeSlashAction(handleCode),
    },
    {
      id: 'blockquote',
      label: 'Blockquote',
      hint: 'Quote',
      shortcut: 'Ctrl+Shift+>',
      keywords: ['quote', 'blockquote', 'citation'],
      icon: createElement(IconBlockquote, { size: 16 }),
      onSelect: () => executeSlashAction(handleSlashQuote),
    },
    {
      id: 'link',
      label: 'Link',
      hint: 'Link',
      shortcut: 'Ctrl+K',
      keywords: ['link', 'url'],
      icon: createElement(IconLink, { size: 16 }),
      onSelect: () => executeSlashAction(handleLink),
    },
    {
      id: 'bullet-list',
      label: 'Bullet List',
      hint: 'Bullet',
      shortcut: 'Ctrl+Shift+8',
      keywords: ['bullet', 'list', 'unordered'],
      icon: createElement(IconList, { size: 16 }),
      onSelect: () => executeSlashAction(handleSlashBulletList),
    },
    {
      id: 'ordered-list',
      label: 'Ordered List',
      hint: 'Ordered',
      shortcut: 'Ctrl+Shift+7',
      keywords: ['ordered', 'list', 'number', 'numbered'],
      icon: createElement(IconListNumbers, { size: 16 }),
      onSelect: () => executeSlashAction(handleSlashOrderedList),
    },
    {
      id: 'task-list',
      label: 'Task List',
      hint: 'Check',
      shortcut: 'Ctrl+Shift+[',
      keywords: ['task', 'check', 'list', 'todo', 'checkbox'],
      icon: createElement(IconListCheck, { size: 16 }),
      onSelect: () => executeSlashAction(handleSlashTaskList),
    },
    {
      id: 'table',
      label: 'Table',
      hint: 'Table',
      keywords: ['table', 'grid'],
      icon: createElement(IconTable, { size: 16 }),
      onSelect: () => executeSlashAction(handleSlashInsertTable),
    },
    {
      id: 'image',
      label: 'Image',
      hint: 'Img',
      shortcut: 'Ctrl+Shift+I',
      keywords: ['image', 'photo', 'upload'],
      icon: createElement(IconPhoto, { size: 16 }),
      onSelect: () => executeSlashAction(handleImageUploadFromSlash),
    },
    {
      id: 'divider',
      label: 'Divider',
      hint: 'Line',
      keywords: ['divider', 'hr', 'line', 'separator', 'horizontal rule'],
      icon: createElement('span', { className: 'text-lg' }, '\u2014'),
      onSelect: () => executeSlashAction(handleSlashDivider),
    },
    {
      id: 'tag',
      label: 'Tag',
      hint: 'Tag',
      shortcut: 'Ctrl+Shift+#',
      keywords: ['tag', 'label', 'property', '#'],
      icon: createElement('span', { className: 'text-sm' }, '#'),
      onSelect: () => executeSlashAction(handleSlashTag),
    },
  ];

  return {
    slashMenuState,
    handleSlashMenuSuggest,
    closeSlashMenu,
    slashCommands,
  };
}
