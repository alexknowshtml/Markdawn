import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcut } from '../../contexts/KeyboardShortcutContext';
import { useAwareness } from '../../hooks/useAwareness';
import { useFloatingToolbar } from '../../hooks/useFloatingToolbar';
import { useMilkdown } from '../../hooks/useMilkdown';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { useWikiLinkSuggestions } from '../../hooks/useWikiLinkSuggestions';
import { authClient } from '../../lib/auth-client';
import { getLogger } from '../../logger-init';
import { ensureAbsoluteUrl } from '../../utils/url';
import './editor.css';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Editor } from '@milkdown/core';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
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
import { getClosestListType, switchListType, unwrapList, wrapBlocksInList } from './listCommands';
import { SlashMenu } from './SlashMenu';
import { WikiLinkSuggestions } from './WikiLinkSuggestions';

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

function _execEditorAction(editor: Editor | null, fn: (ctx: unknown) => void): void {
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

        const closestListDisplayType = getClosestListType(state);

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
          isBulletListActive: closestListDisplayType === 'bullet',
          isOrderedListActive: closestListDisplayType === 'ordered',
          isTaskListActive: closestListDisplayType === 'task',
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

  const handleSlashMenuSuggestRef = useRef<
    (
      isOpen: boolean,
      query: string,
      position: { x: number; y: number; top?: number; bottom?: number } | null,
      range: { from: number; to: number } | null,
    ) => void
  >(() => {});

  const { setContainer, editor } = useMilkdown({
    ...(initialValue !== undefined && { initialValue }),
    ...(onChange !== undefined && { onChange }),
    doc,
    provider,
    onWikiLinkClick,
    onWikiLinkSuggest: handleWikiLinkSuggest,
    onSlashMenuSuggest: useCallback((isOpen, query, position, range) => {
      handleSlashMenuSuggestRef.current(isOpen, query, position, range);
    }, []),
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

  const { visible, position, keepVisible, reposition } = useFloatingToolbar();

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

      let currentLevel: number | null = null;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === nodeType && 'level' in node.attrs) {
          currentLevel = node.attrs.level;
          break;
        }
      }

      const targetLevel = attrs?.level as number | undefined;
      if (Number(currentLevel) === Number(targetLevel)) {
        const command = setBlockType(paraType as never);
        command(state, dispatch);
      } else {
        const command = setBlockType(nodeType as never, attrs);
        command(state, dispatch);
      }
      setTimeout(reposition, 0);
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

        const mark = linkMark.create({ href: ensureAbsoluteUrl(url) });
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

  const { slashMenuState, handleSlashMenuSuggest, closeSlashMenu, slashCommands } = useSlashMenu(
    editorRef,
    {
      handleBold,
      handleItalic,
      handleStrike,
      handleCode,
      handleLink,
      handleImageUploadFromSlash,
    },
  );

  handleSlashMenuSuggestRef.current = handleSlashMenuSuggest;

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
      if (!bulletListType || !dispatch) return;

      // Base decisions on the closest (innermost) list, not any ancestor.
      // This ensures ordered lists nested inside bullets convert correctly
      // instead of accidentally unwrapping the inner list.
      const closestType = getClosestListType(state);
      if (closestType === 'task') {
        switchListType(state, bulletListType, dispatch, {});
      } else if (closestType === 'bullet') {
        unwrapList(state, dispatch);
      } else if (closestType === 'ordered') {
        switchListType(state, bulletListType, dispatch);
      } else {
        wrapBlocksInList(state, bulletListType, dispatch);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
  };
  const handleOrderedList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const orderedListType = state.schema.nodes.ordered_list;
      if (!orderedListType || !dispatch) return;

      const closestType = getClosestListType(state);
      if (closestType === 'ordered') {
        // Check if the selection also contains top-level blocks outside
        // any list. If so, rebuild all content into one list.
        const { from, to } = state.selection;
        const listItemType = state.schema.nodes.list_item;
        let hasNonList = false;
        if (from !== to) {
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isBlock || node.type.name === 'doc') return;
            const $pos = state.doc.resolve(pos);
            if ($pos.depth <= 1 && node.type !== listItemType && node.type !== orderedListType) {
              hasNonList = true;
            }
          });
        }
        if (!hasNonList) {
          unwrapList(state, dispatch);
        } else {
          wrapBlocksInList(state, orderedListType, dispatch);
        }
      } else if (closestType === 'task') {
        switchListType(state, orderedListType, dispatch, {});
      } else if (closestType === 'bullet') {
        switchListType(state, orderedListType, dispatch);
      } else {
        wrapBlocksInList(state, orderedListType, dispatch);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
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

      const taskAttrs = { checked: false };
      const closestType = getClosestListType(state);
      if (closestType === 'task') {
        unwrapList(state, dispatch);
      } else if (closestType === 'bullet' || closestType === 'ordered') {
        switchListType(state, bulletListType, dispatch, taskAttrs);
      } else {
        wrapBlocksInList(state, bulletListType, dispatch, taskAttrs);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
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

  // ─── Keyboard shortcut registrations for slash menu commands ───

  // Utility: returns true only when the Milkdown/ProseMirror editor has DOM focus.
  // Editor-scoped shortcuts use this to avoid capturing shortcuts meant
  // for the command palette, page title, or other inputs.
  function editorHasFocus(): boolean {
    if (!editor) return false;
    let focused = false;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view) focused = view.hasFocus();
      });
    } catch {
      /* Editor may have been destroyed */
    }
    return focused;
  }

  // Helper: wraps an editor action so it only fires when the editor is focused,
  // and returns false to allow the next binding to handle the event otherwise.
  const ed = (action: () => void) => (): boolean => {
    if (!editorHasFocus()) return false;
    action();
    return true;
  };

  // Mapping from normalized shortcut → handler for every slash-command shortcut.
  // The slash menu displays these same shortcuts — these registrations make
  // them functional as real keyboard bindings.
  useShortcut({
    key: 'mod+alt+0',
    handler: ed(() => runBlockCommand('paragraph')),
    scope: 'editor',
    description: 'Paragraph',
  });
  useShortcut({
    key: 'mod+alt+1',
    handler: ed(handleH1),
    scope: 'editor',
    description: 'Heading 1',
  });
  useShortcut({
    key: 'mod+alt+2',
    handler: ed(handleH2),
    scope: 'editor',
    description: 'Heading 2',
  });
  useShortcut({
    key: 'mod+alt+3',
    handler: ed(handleH3),
    scope: 'editor',
    description: 'Heading 3',
  });
  useShortcut({
    key: 'mod+alt+4',
    handler: ed(handleH4),
    scope: 'editor',
    description: 'Heading 4',
  });
  useShortcut({
    key: 'mod+alt+5',
    handler: ed(handleH5),
    scope: 'editor',
    description: 'Heading 5',
  });
  useShortcut({
    key: 'mod+alt+6',
    handler: ed(handleH6),
    scope: 'editor',
    description: 'Heading 6',
  });
  useShortcut({ key: 'mod+b', handler: ed(handleBold), scope: 'editor', description: 'Bold' });
  useShortcut({ key: 'mod+i', handler: ed(handleItalic), scope: 'editor', description: 'Italic' });
  useShortcut({
    key: 'mod+shift+x',
    handler: ed(handleStrike),
    scope: 'editor',
    description: 'Strikethrough',
  });
  useShortcut({ key: 'mod+`', handler: ed(handleCode), scope: 'editor', description: 'Code' });
  useShortcut({
    key: 'mod+shift+>',
    handler: ed(handleBlockquote),
    scope: 'editor',
    description: 'Blockquote',
  });
  // Ctrl+K: only opens the link dialog when text is selected in the editor.
  // When the editor is unfocused or no text is selected, returns false so
  // the command palette's mod+k can fire.
  useShortcut({
    key: 'mod+k',
    handler: (): boolean => {
      if (!editor) return false;
      let canLink = false;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view?.hasFocus()) return;
        const { from, to } = view.state.selection;
        canLink = from !== to;
      });
      if (!canLink) return false;
      handleLink();
      return true;
    },
    scope: 'editor',
    priority: 'high',
    description: 'Insert link',
  });
  // Ctrl+Shift+number: different browsers behave differently — most suppress
  // Shift's character mapping when Ctrl is held (event.key stays '8'), but
  // Zen and some others produce the shifted character ('*'). Register both
  // forms so it works everywhere.
  useShortcut({
    key: 'mod+shift+8',
    handler: ed(handleBulletList),
    scope: 'editor',
    description: 'Bullet list',
  });
  useShortcut({
    key: 'mod+shift+*',
    handler: ed(handleBulletList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+7',
    handler: ed(handleOrderedList),
    scope: 'editor',
    description: 'Ordered list',
  });
  useShortcut({
    key: 'mod+shift+&',
    handler: ed(handleOrderedList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+[',
    handler: ed(handleTaskList),
    scope: 'editor',
    description: 'Task list',
  });
  useShortcut({
    key: 'mod+shift+{',
    handler: ed(handleTaskList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+i',
    handler: ed(handleImageUploadFromSlash),
    scope: 'editor',
    description: 'Insert image',
  });
  useShortcut({
    key: 'mod+shift+#',
    handler: ed(() => {
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view) return;
        const { $from } = view.state.selection;
        const tr = view.state.tr.insertText('#tag ', $from.pos);
        view.dispatch(tr);
      });
    }),
    scope: 'editor',
    description: 'Insert tag',
  });

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
