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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAwareness } from '../../hooks/useAwareness';
import { useFloatingToolbar } from '../../hooks/useFloatingToolbar';
import { useMilkdown } from '../../hooks/useMilkdown';
import { useWikiLinkSuggestions } from '../../hooks/useWikiLinkSuggestions';
import { authClient } from '../../lib/auth-client';
import { getLogger } from '../../logger-init';
import './editor.css';
import { WebSocketStatus } from '@hocuspocus/provider';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { Editor } from '@milkdown/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
} from 'prosemirror-tables';
import * as Y from 'yjs';
import { FloatingToolbar } from './FloatingToolbar';
import { SlashMenu } from './SlashMenu';
import { WikiLinkSuggestions } from './WikiLinkSuggestions';

function hasTaskListAncestor(state: EditorState): boolean {
  const listItemType = state.schema.nodes.list_item;
  if (!listItemType) return false;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === listItemType && node.attrs.checked != null) return true;
  }
  // Handle AllSelection / depth-0: search the full selection range
  if ($from.depth === 0) {
    const { from, to } = state.selection;
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.type === listItemType && node.attrs.checked != null) {
        found = true;
        return false;
      }
      return;
    });
    return found;
  }
  return false;
}

function unwrapList(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  const schema = state.schema;

  let listStart = -1;
  let listEnd = -1;
  let listNode: import('prosemirror-model').Node | null = null;

  // First try: traverse ancestors from cursor position
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list) {
      listStart = $from.before(d);
      listEnd = $from.after(d);
      listNode = node;
      break;
    }
  }

  // Fallback for AllSelection / depth-0: find the list among direct doc children
  if (!listNode && $from.depth === 0) {
    let pos = 0;
    for (let i = 0; i < state.doc.content.childCount; i++) {
      const child = state.doc.content.child(i);
      if (child.type === schema.nodes.bullet_list || child.type === schema.nodes.ordered_list) {
        listStart = pos;
        listEnd = pos + child.nodeSize;
        listNode = child;
        break;
      }
      pos += child.nodeSize;
    }
  }

  if (!listNode) return false;

  const listItemType = schema.nodes.list_item;
  const content: unknown[] = [];
  for (let i = 0; i < listNode.content.childCount; i++) {
    const child = listNode.content.child(i);
    if (child.type === listItemType) {
      for (let j = 0; j < child.content.childCount; j++) {
        content.push(child.content.child(j));
      }
    }
  }

  if (content.length === 0) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(listStart, listEnd, content as never);
    // Collapse selection to cursor at end of unwrapped content,
    // combined with view.focus() in the caller this ensures
    // ProseMirror's updateSelection() fires and the cursor lands correctly.
    const afterSize = tr.doc.content.size;
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, afterSize - 1))));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

interface MilkdownEditorProps {
  pageId: string;
  workspaceId: string;
  initialValue?: string;
  onChange?: (markdown: string) => void;
  onProviderReady?: (provider: HocuspocusProvider) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
  onWikiLinkClick?: (path: string) => void;
}

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';

function execEditorAction(editor: Editor | null, fn: (ctx: unknown) => void): void {
  if (!editor) return;
  try {
    editor.action(fn);
  } catch {
    /* Editor may have been destroyed */
  }
}

export function MilkdownEditor({
  pageId,
  workspaceId,
  initialValue,
  onChange,
  onStatusChange,
  onProviderReady,
  onWikiLinkClick,
}: MilkdownEditorProps) {
  const doc = useMemo(() => new Y.Doc(), []);
  const editorRef = useRef<Editor | null>(null);

  const {
    suggestions,
    allPages,
    handleWikiLinkSuggest,
    handleWikiLinkSelect,
    handleAddPage,
    closeSuggestions,
  } = useWikiLinkSuggestions(workspaceId, editorRef);

  const [slashMenuState, setSlashMenuState] = useState({
    isOpen: false,
    query: '',
    position: null as { x: number; y: number; top?: number; bottom?: number } | null,
    range: null as { from: number; to: number } | null,
  });

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

  const [activeStates, setActiveStates] = useState({
    isBoldActive: false,
    isItalicActive: false,
    isStrikeActive: false,
    isCodeActive: false,
    isLinkActive: false,
    isBlockquoteActive: false,
    isH1Active: false,
    isH2Active: false,
    isH3Active: false,
    isH4Active: false,
    isH5Active: false,
    isH6Active: false,
    isBulletListActive: false,
    isOrderedListActive: false,
    isTaskListActive: false,
    isInTableActive: false,
  });

  const hasMark = useCallback((state: EditorState, markType?: MarkType): boolean => {
    if (!markType) return false;
    const { selection, storedMarks, doc } = state;
    if (selection.empty) {
      return !!markType.isInSet(storedMarks ?? selection.$head.marks());
    }
    return doc.rangeHasMark(selection.from, selection.to, markType);
  }, []);

  const hasBlockType = useCallback(
    (state: EditorState, nodeType?: NodeType, attrs?: Record<string, unknown>): boolean => {
      if (!nodeType) return false;
      const { $from } = state.selection;

      const depth = $from.depth;
      for (let d = depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === nodeType) {
          if (!attrs) return true;
          for (const [key, value] of Object.entries(attrs)) {
            const nodeValue = node.attrs[key];
            if (String(nodeValue) !== String(value)) {
              return false;
            }
          }
          return true;
        }
      }
      return false;
    },
    [],
  );

  const hasParentBlockType = useCallback((state: EditorState, nodeType?: NodeType): boolean => {
    if (!nodeType) return false;
    const { $from } = state.selection;
    const depth = $from.depth;
    for (let d = depth; d > 0; d--) {
      if ($from.node(d).type === nodeType) {
        return true;
      }
    }
    // Handle AllSelection / depth-0: check doc's direct children
    if (depth === 0) {
      for (let i = 0; i < state.doc.content.childCount; i++) {
        if (state.doc.content.child(i).type === nodeType) {
          return true;
        }
      }
    }
    return false;
  }, []);

  const updateActiveStates = useCallback(() => {
    const editorInstance = editorRef.current as unknown as {
      action: (cb: (ctx: unknown) => void) => void;
    } | null;
    if (!editorInstance) return;
    try {
      editorInstance.action((ctx) => {
        const view = (ctx as unknown as { get: (key: unknown) => unknown }).get(editorViewCtx);
        if (!view) return;
        const { state } = view as { state: EditorState };
        const schema = state.schema as unknown as {
          marks: Record<string, MarkType>;
          nodes: Record<string, NodeType>;
        };
        const marks = schema.marks;
        const nodes = schema.nodes;

        const isTaskListItem = hasTaskListAncestor(state);

        setActiveStates({
          isBoldActive: hasMark(state, marks.strong),
          isItalicActive: hasMark(state, marks.emphasis),
          isStrikeActive: hasMark(state, marks.strike_through),
          isCodeActive: hasMark(state, marks.inlineCode) || hasBlockType(state, nodes.code_block),
          isLinkActive: hasMark(state, marks.link),
          isBlockquoteActive: hasParentBlockType(state, nodes.blockquote),
          isH1Active: hasBlockType(state, nodes.heading, { level: 1 }),
          isH2Active: hasBlockType(state, nodes.heading, { level: 2 }),
          isH3Active: hasBlockType(state, nodes.heading, { level: 3 }),
          isH4Active: hasBlockType(state, nodes.heading, { level: 4 }),
          isH5Active: hasBlockType(state, nodes.heading, { level: 5 }),
          isH6Active: hasBlockType(state, nodes.heading, { level: 6 }),
          isBulletListActive: hasParentBlockType(state, nodes.bullet_list) && !isTaskListItem,
          isOrderedListActive: hasParentBlockType(state, nodes.ordered_list),
          isTaskListActive: isTaskListItem,
          isInTableActive: isInTable(state),
        });
      });
    } catch {
      // Editor may have been destroyed
    }
  }, [hasMark, hasBlockType, hasParentBlockType]);

  // Cache the collab session token so HocuspocusProvider reconnection
  // doesn't fire a redundant get-session API call on every retry.
  // Key the cache by user ID to avoid session fixation on shared machines.
  const cachedTokenRef = useRef<{ token: string; userId: string; expiresAt: number } | null>(null);

  const provider = useMemo(() => {
    return new HocuspocusProvider({
      url: COLLAB_URL,
      name: pageId,
      document: doc,
      forceSyncInterval: 2000,
      token: async () => {
        const cached = cachedTokenRef.current;
        if (cached && Date.now() < cached.expiresAt) {
          return cached.token;
        }
        const session = await authClient.getSession();
        const token = session.data?.session?.token ?? '';
        const userId = session.data?.user?.id ?? '';
        cachedTokenRef.current = { token, userId, expiresAt: Date.now() + 5 * 60 * 1000 };
        return token;
      },
    });
  }, [pageId, doc]);

  const { setContainer, editor } = useMilkdown({
    ...(initialValue !== undefined && { initialValue }),
    ...(onChange !== undefined && { onChange }),
    doc,
    provider,
    onWikiLinkClick,
    onWikiLinkSuggest: handleWikiLinkSuggest,
    onSlashMenuSuggest: handleSlashMenuSuggest,
  });

  useAwareness(provider);

  // Cleanup: destroy provider and Y.Doc on unmount. The ref-capture
  // pattern distinguishes Strict Mode double-fire from real unmount:
  // when latest refs differ from captured, we know the instances were
  // replaced (Strict Mode re-render) and we destroy the old ones
  // immediately. When refs match, we wait for isMountedRef to flip
  // false (real unmount) via setTimeout.
  // The status listener effect below is declared AFTER this one, so
  // React cleans it up FIRST (bottom-to-top), removing the listener
  // before provider.destroy() fires its disconnected event.
  const isMountedRef = useRef(true);
  const latestProviderRef = useRef(provider);
  const latestDocRef = useRef(doc);
  latestProviderRef.current = provider;
  latestDocRef.current = doc;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const capturedProvider = provider;
    const capturedDoc = doc;

    return () => {
      if (latestProviderRef.current !== capturedProvider || latestDocRef.current !== capturedDoc) {
        capturedProvider.forceSync();
        capturedProvider.destroy();
        capturedDoc.destroy();
        return;
      }
      setTimeout(() => {
        if (!isMountedRef.current) {
          capturedProvider.forceSync();
          capturedProvider.destroy();
          capturedDoc.destroy();
        }
      }, 0);
    };
  }, [provider, doc]);

  const { visible, position, keepVisible } = useFloatingToolbar();

  const runMarkCommand = (markName: string, attrs?: Record<string, unknown>) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const marks = (state.schema as unknown as { marks: Record<string, unknown> }).marks;
      const markType = marks[markName];
      if (!markType) return;

      const command = toggleMark(markType as never, attrs);
      command(state, dispatch);
    });
  };

  const runBlockCommand = (nodeName: string, attrs?: Record<string, unknown>) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const nodes = (state.schema as unknown as { nodes: Record<string, unknown> }).nodes;
      const nodeType = nodes[nodeName];
      const paraType = nodes.paragraph;
      if (!nodeType || !paraType) return;

      const { $from } = state.selection;
      const pos = $from.pos;

      let currentLevel: number | null = null;
      state.doc.nodesBetween(pos, pos + 1, (node) => {
        if (node.type === nodeType && node.attrs.level) {
          currentLevel = node.attrs.level;
        }
      });

      const targetLevel = attrs?.level as number | undefined;
      if (currentLevel === targetLevel) {
        const command = setBlockType(paraType as never);
        command(state, dispatch);
      } else {
        const command = setBlockType(nodeType as never, attrs);
        command(state, dispatch);
      }
    });
  };

  const runCodeCommand = () => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const schema = state.schema as unknown as { nodes: Record<string, NodeType> };
      const nodes = schema.nodes;
      const marks = (state.schema as unknown as { marks: Record<string, MarkType> }).marks;
      const codeBlockType = nodes.code_block;
      const paragraphType = nodes.paragraph;
      const inlineCodeMark = marks.inlineCode;

      if (!codeBlockType || !paragraphType) {
        if (!inlineCodeMark) return;
        const command = toggleMark(inlineCodeMark as never);
        command(state, dispatch);
        return;
      }

      const isCodeBlockActive = hasBlockType(state, codeBlockType);

      if (isCodeBlockActive) {
        const $from = state.selection.$from;
        const blockStart = $from.before($from.depth);
        const blockEnd = $from.after($from.depth);
        const codeBlock = state.doc.nodeAt(blockStart);

        if (codeBlock && codeBlock.type === codeBlockType) {
          const content = codeBlock.textContent;
          const lines = content
            .split('\n')
            .filter((line, i, arr) => line.length > 0 || i < arr.length - 1);
          const paragraphNodes = lines.map((line) =>
            (paragraphType as NodeType).create(null, state.schema.text(line)),
          );
          const tr = state.tr.replaceWith(blockStart, blockEnd, paragraphNodes);
          dispatch(tr);
        }
        return;
      }

      const { from, to } = state.selection;
      const selectedText = state.doc.textBetween(from, to, '\n', '\n');
      const isMultiline =
        from !== to &&
        (selectedText.includes('\n') ||
          state.selection.$from.start() !== state.selection.$to.start());

      if (isMultiline) {
        const textNode = state.schema.text(selectedText);
        const codeBlock = (codeBlockType as NodeType).create({ language: '' }, textNode);
        const tr = state.tr.replaceSelectionWith(codeBlock);
        dispatch(tr);
        return;
      }

      if (!inlineCodeMark) return;
      const command = toggleMark(inlineCodeMark as never);
      command(state, dispatch);
    });
  };

  // Slash-specific handlers that don't call keepVisible()
  const handleSlashParagraph = () => {
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
    if (!editor) return;
    editor.action((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(insertTableCommand.key, { row: 3, col: 3 });
    });
  };

  const handleSlashDivider = () => {
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
    const range = slashMenuState.range;
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
      icon: <span className="text-xs">¶</span>,
      onSelect: () => executeSlashAction(handleSlashParagraph),
    },
    {
      id: 'h1',
      label: 'Heading 1',
      hint: 'H1',
      shortcut: 'Ctrl+Alt+1',
      keywords: ['heading', 'h1', 'title'],
      icon: <IconH1 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(1)),
    },
    {
      id: 'h2',
      label: 'Heading 2',
      hint: 'H2',
      shortcut: 'Ctrl+Alt+2',
      keywords: ['heading', 'h2'],
      icon: <IconH2 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(2)),
    },
    {
      id: 'h3',
      label: 'Heading 3',
      hint: 'H3',
      shortcut: 'Ctrl+Alt+3',
      keywords: ['heading', 'h3'],
      icon: <IconH3 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(3)),
    },
    {
      id: 'h4',
      label: 'Heading 4',
      hint: 'H4',
      shortcut: 'Ctrl+Alt+4',
      keywords: ['heading', 'h4'],
      icon: <IconH4 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(4)),
    },
    {
      id: 'h5',
      label: 'Heading 5',
      hint: 'H5',
      shortcut: 'Ctrl+Alt+5',
      keywords: ['heading', 'h5'],
      icon: <IconH5 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(5)),
    },
    {
      id: 'h6',
      label: 'Heading 6',
      hint: 'H6',
      shortcut: 'Ctrl+Alt+6',
      keywords: ['heading', 'h6'],
      icon: <IconH6 size={16} />,
      onSelect: () => executeSlashAction(() => handleSlashHeading(6)),
    },
    {
      id: 'bold',
      label: 'Bold',
      hint: 'Bold',
      shortcut: 'Ctrl+B',
      keywords: ['bold', 'strong'],
      icon: <IconBold size={16} />,
      onSelect: () => executeSlashAction(handleBold),
    },
    {
      id: 'italic',
      label: 'Italic',
      hint: 'Italic',
      shortcut: 'Ctrl+I',
      keywords: ['italic', 'emphasis'],
      icon: <IconItalic size={16} />,
      onSelect: () => executeSlashAction(handleItalic),
    },
    {
      id: 'strikethrough',
      label: 'Strikethrough',
      hint: 'Strike',
      shortcut: 'Ctrl+Shift+X',
      keywords: ['strikethrough', 'strike'],
      icon: <IconStrikethrough size={16} />,
      onSelect: () => executeSlashAction(handleStrike),
    },
    {
      id: 'code',
      label: 'Code',
      hint: 'Code',
      shortcut: 'Ctrl+`',
      keywords: ['code', 'inline'],
      icon: <IconCode size={16} />,
      onSelect: () => executeSlashAction(handleCode),
    },
    {
      id: 'blockquote',
      label: 'Blockquote',
      hint: 'Quote',
      shortcut: 'Ctrl+Shift+>',
      keywords: ['quote', 'blockquote', 'citation'],
      icon: <IconBlockquote size={16} />,
      onSelect: () => executeSlashAction(handleSlashQuote),
    },
    {
      id: 'link',
      label: 'Link',
      hint: 'Link',
      shortcut: 'Ctrl+K',
      keywords: ['link', 'url'],
      icon: <IconLink size={16} />,
      onSelect: () => executeSlashAction(handleLink),
    },
    {
      id: 'bullet-list',
      label: 'Bullet List',
      hint: 'Bullet',
      shortcut: 'Ctrl+Shift+8',
      keywords: ['bullet', 'list', 'unordered'],
      icon: <IconList size={16} />,
      onSelect: () => executeSlashAction(handleSlashBulletList),
    },
    {
      id: 'ordered-list',
      label: 'Ordered List',
      hint: 'Ordered',
      shortcut: 'Ctrl+Shift+7',
      keywords: ['ordered', 'list', 'number', 'numbered'],
      icon: <IconListNumbers size={16} />,
      onSelect: () => executeSlashAction(handleSlashOrderedList),
    },
    {
      id: 'task-list',
      label: 'Task List',
      hint: 'Check',
      shortcut: 'Ctrl+Shift+[',
      keywords: ['task', 'check', 'list', 'todo', 'checkbox'],
      icon: <IconListCheck size={16} />,
      onSelect: () => executeSlashAction(handleSlashTaskList),
    },
    {
      id: 'table',
      label: 'Table',
      hint: 'Table',
      keywords: ['table', 'grid'],
      icon: <IconTable size={16} />,
      onSelect: () => executeSlashAction(handleSlashInsertTable),
    },
    {
      id: 'image',
      label: 'Image',
      hint: 'Img',
      shortcut: 'Ctrl+Shift+I',
      keywords: ['image', 'photo', 'upload'],
      icon: <IconPhoto size={16} />,
      onSelect: () => executeSlashAction(handleImageUploadFromSlash),
    },
    {
      id: 'divider',
      label: 'Divider',
      hint: 'Line',
      keywords: ['divider', 'hr', 'line', 'separator', 'horizontal rule'],
      icon: <span className="text-lg">—</span>,
      onSelect: () => executeSlashAction(handleSlashDivider),
    },
    {
      id: 'tag',
      label: 'Tag',
      hint: 'Tag',
      shortcut: 'Ctrl+Shift+#',
      keywords: ['tag', 'label', 'property', '#'],
      icon: <span className="text-sm">#</span>,
      onSelect: () => executeSlashAction(handleSlashTag),
    },
  ];

  const handleBold = () => {
    runMarkCommand('strong');
    setTimeout(updateActiveStates, 0);
  };
  const handleItalic = () => {
    runMarkCommand('emphasis');
    setTimeout(updateActiveStates, 0);
  };
  const handleStrike = () => {
    runMarkCommand('strike_through');
    setTimeout(updateActiveStates, 0);
  };
  const handleCode = () => {
    runCodeCommand();
    setTimeout(updateActiveStates, 0);
  };
  const handleLink = () => {
    const url = prompt('Enter link URL:');
    if (url && editor) {
      keepVisible();
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view) return;

        const { state, dispatch } = view;
        const linkMark = state.schema.marks.link;
        if (!linkMark) return;

        const mark = linkMark.create({ href: url });
        const tr = state.tr.addMark(state.selection.from, state.selection.to, mark);
        dispatch(tr);
      });
      setTimeout(updateActiveStates, 0);
    }
  };

  const handleBlockquote = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const blockquoteType = state.schema.nodes.blockquote;
      if (!blockquoteType) return;

      const inBlockquote = hasParentBlockType(state, blockquoteType);

      if (inBlockquote) {
        const command = lift;
        command(state, dispatch);
      } else {
        const command = wrapIn(blockquoteType as never);
        command(state, dispatch);
      }
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleImageUpload = async (file: File) => {
    if (!workspaceId) {
      alert('No workspace selected');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('workspaceId', workspaceId);
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? 'Upload failed');
      }
      const data = await res.json();
      const imageMarkdown = `![${file.name}](${data.url})`;
      if (editor) {
        keepVisible();
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!view) return;
          const { state, dispatch } = view;
          const imageNode = state.schema.nodes.image;
          if (!imageNode) {
            const text = state.selection.from;
            const tr = state.tr.insert(text, state.schema.text(imageMarkdown));
            dispatch(tr);
            return;
          }
          const node = imageNode.create({ src: data.url, alt: file.name });
          const tr = state.tr.insert(state.selection.from, node);
          dispatch(tr);
        });
      }
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
    }
  };

  const handleImageUploadFromSlash = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        handleImageUpload(file);
      }
    };
    input.click();
  };
  const handleH1 = () => {
    runBlockCommand('heading', { level: 1 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH2 = () => {
    runBlockCommand('heading', { level: 2 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH3 = () => {
    runBlockCommand('heading', { level: 3 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH4 = () => {
    runBlockCommand('heading', { level: 4 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH5 = () => {
    runBlockCommand('heading', { level: 5 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH6 = () => {
    runBlockCommand('heading', { level: 6 });
    setTimeout(updateActiveStates, 0);
  };
  const handleBulletList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      const listItemType = state.schema.nodes.list_item;
      if (!bulletListType || !listItemType || !dispatch) return;

      if (hasParentBlockType(state, bulletListType) && !hasTaskListAncestor(state)) {
        unwrapList(state, dispatch);
      } else {
        wrapIn(bulletListType as never)(state, dispatch);
      }
    });
    // Refocus after React state from keepVisible() settles so the
    // toolbar DOM isn't torn down during a concurrent test click.
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
  };
  const handleOrderedList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const orderedListType = state.schema.nodes.ordered_list;
      const listItemType = state.schema.nodes.list_item;
      if (!orderedListType || !listItemType || !dispatch) return;

      if (hasParentBlockType(state, orderedListType)) {
        unwrapList(state, dispatch);
      } else {
        wrapIn(orderedListType as never)(state, dispatch);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
  };
  const handleTaskList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      const listItemType = state.schema.nodes.list_item;
      if (!bulletListType || !listItemType || !dispatch) return;

      if (hasTaskListAncestor(state)) {
        unwrapList(state, dispatch);
      } else {
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
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
  };

  const handleInsertTable = () => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(insertTableCommand.key, { row: 3, col: 3 });
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleTableAction = (
    action:
      | 'addRowBefore'
      | 'addRowAfter'
      | 'addColBefore'
      | 'addColAfter'
      | 'deleteRow'
      | 'deleteCol'
      | 'deleteTable',
  ) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const viewInstance = ctx.get(editorViewCtx) as EditorView | undefined;
      if (!viewInstance) return;

      const { state, dispatch } = viewInstance;

      if (!isInTable(state)) return;

      switch (action) {
        case 'addRowBefore':
          addRowBefore(state, dispatch);
          break;
        case 'addRowAfter':
          addRowAfter(state, dispatch);
          break;
        case 'addColBefore':
          addColumnBefore(state, dispatch);
          break;
        case 'addColAfter':
          addColumnAfter(state, dispatch);
          break;
        case 'deleteRow':
          deleteRow(state, dispatch);
          break;
        case 'deleteCol':
          deleteColumn(state, dispatch);
          break;
        case 'deleteTable':
          deleteTable(state, dispatch);
          break;
      }
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleAddRowBefore = () => handleTableAction('addRowBefore');
  const handleAddRowAfter = () => handleTableAction('addRowAfter');
  const handleAddColBefore = () => handleTableAction('addColBefore');
  const handleAddColAfter = () => handleTableAction('addColAfter');
  const handleDeleteRow = () => handleTableAction('deleteRow');
  const handleDeleteCol = () => handleTableAction('deleteCol');
  const handleDeleteTable = () => handleTableAction('deleteTable');

  useEffect(() => {
    onProviderReady?.(provider);
  }, [provider, onProviderReady]);

  const latestOnStatusChange = useRef(onStatusChange);
  latestOnStatusChange.current = onStatusChange;
  const logger = getLogger();

  // biome-ignore lint/correctness/useExhaustiveDependencies: logger is stable, doc.on/off are event subscriptions
  useEffect(() => {
    const handleStatus = ({ status }: { status: WebSocketStatus }) => {
      logger.debug`[collab] status: ${status}`;
      const cb = latestOnStatusChange.current;
      if (cb) {
        cb(status);
      }
    };

    const handleSync = ({ documentName, state }: { documentName: string; state: Uint8Array }) => {
      logger.debug`[collab] synced to server: ${documentName}, ${state.length} bytes`;
    };

    const handlePersisted = ({ documentName }: { documentName: string }) => {
      logger.debug`[collab] persisted to db: ${documentName}`;
    };

    const handleAwareness = (args: unknown) => {
      logger.debug`[collab] awareness: ${JSON.stringify(args).slice(0, 100)}`;
    };

    const handleError = (args: unknown) => {
      logger.error`[collab] error: ${args}`;
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('persisted', handlePersisted);
    provider.on('awareness', handleAwareness);
    provider.on('error', handleError);

    const onDocUpdate = (_update: Uint8Array, origin: unknown) => {
      logger.debug`[collab] doc update: origin=${String(origin)}, bytes=${_update.length}`;
    };
    doc.on('update', onDocUpdate);

    logger.info`[editor] connecting to collab: ${pageId}`;

    setTimeout(() => {
      if (latestOnStatusChange.current) {
        latestOnStatusChange.current(WebSocketStatus.Connecting);
      }
    }, 0);

    return () => {
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.off('persisted', handlePersisted);
      provider.off('awareness', handleAwareness);
      provider.off('error', handleError);
      doc.off('update', onDocUpdate);
      logger.debug`[editor] disconnected: ${pageId}`;
    };
  }, [provider, pageId]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const editorInstanceRef = editor;
    let isMounted = true;

    const handleSelectionChange = () => {
      if (!isMounted) return;
      updateActiveStates();
    };

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      view.dom.addEventListener('keyup', handleSelectionChange);
      view.dom.addEventListener('mouseup', handleSelectionChange);
    });

    return () => {
      isMounted = false;
      try {
        editorInstanceRef.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!view) return;
          view.dom.removeEventListener('keyup', handleSelectionChange);
          view.dom.removeEventListener('mouseup', handleSelectionChange);
        });
      } catch {
        // Editor may have been destroyed during cleanup race condition
      }
    };
  }, [editor, updateActiveStates]);

  return (
    <div className="editor-wrapper min-h-[500px] relative">
      <WikiLinkSuggestions
        isOpen={suggestions.isOpen}
        query={suggestions.query}
        pages={allPages}
        position={suggestions.position}
        onSelect={handleWikiLinkSelect}
        onClose={closeSuggestions}
        onAddPage={handleAddPage}
      />
      <SlashMenu
        isOpen={slashMenuState.isOpen}
        query={slashMenuState.query}
        position={slashMenuState.position}
        commands={slashCommands}
        onClose={closeSlashMenu}
      />
      <FloatingToolbar
        visible={visible}
        position={position}
        onBold={handleBold}
        onItalic={handleItalic}
        onStrike={handleStrike}
        onCode={handleCode}
        onLink={handleLink}
        onBlockquote={handleBlockquote}
        onImageUpload={handleImageUpload}
        onH1={handleH1}
        onH2={handleH2}
        onH3={handleH3}
        onH4={handleH4}
        onH5={handleH5}
        onH6={handleH6}
        onBulletList={handleBulletList}
        onOrderedList={handleOrderedList}
        onTaskList={handleTaskList}
        onInsertTable={handleInsertTable}
        onAddRowBefore={handleAddRowBefore}
        onAddRowAfter={handleAddRowAfter}
        onAddColBefore={handleAddColBefore}
        onAddColAfter={handleAddColAfter}
        onDeleteRow={handleDeleteRow}
        onDeleteCol={handleDeleteCol}
        onDeleteTable={handleDeleteTable}
        {...activeStates}
      />
      <div ref={setContainer} className="milkdown-editor" />
    </div>
  );
}
