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
import { useShortcut } from '../../contexts/KeyboardShortcutContext';
import { useAwareness } from '../../hooks/useAwareness';
import { useFloatingToolbar } from '../../hooks/useFloatingToolbar';
import { useMilkdown } from '../../hooks/useMilkdown';
import { useSlashMenu } from '../../hooks/useSlashMenu';
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

function findParentList(
  state: EditorState,
): { node: import('prosemirror-model').Node; start: number; end: number } | null {
  const { $from } = state.selection;
  const schema = state.schema;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list) {
      return { node, start: $from.before(d), end: $from.after(d) };
    }
  }
  if ($from.depth === 0) {
    let pos = 0;
    for (let i = 0; i < state.doc.content.childCount; i++) {
      const child = state.doc.content.child(i);
      if (child.type === schema.nodes.bullet_list || child.type === schema.nodes.ordered_list) {
        return { node: child, start: pos, end: pos + child.nodeSize };
      }
      pos += child.nodeSize;
    }
  }
  return null;
}

function collectListItems(
  doc: import('prosemirror-model').Node,
  from: number,
  to: number,
): Array<{ node: import('prosemirror-model').Node; pos: number }> {
  const listItemType = doc.type.schema.nodes.list_item;
  const items: Array<{ node: import('prosemirror-model').Node; pos: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === listItemType) {
      items.push({ node, pos });
    }
  });
  return items;
}

/** Unwrap only the list items that intersect with the selection.
 *  Items outside the selection remain in the list. */
function unwrapList(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const schema = state.schema;
  const paragraphType = schema.nodes.paragraph;
  const listInfo = findParentList(state);
  if (!listInfo || !paragraphType) return false;

  const allItems = collectListItems(state.doc, listInfo.start, listInfo.end);

  // Determine which items to unwrap.
  // Collapsed selection: unwrap just the item under cursor.
  // Non-empty selection: unwrap all items intersecting the range.
  const { $from, $to } = state.selection;
  let unwrapPositions: Set<number>;
  let cursorItemPos = -1;
  let cursorOldPos = $from.pos;
  if ($from.pos === $to.pos) {
    const cursorItem = allItems.find(
      (item) => item.pos <= $from.pos && $from.pos < item.pos + item.node.nodeSize,
    );
    if (!cursorItem) return false;
    cursorItemPos = cursorItem.pos;
    unwrapPositions = new Set([cursorItemPos]);
  } else {
    unwrapPositions = new Set(
      collectListItems(state.doc, $from.pos, $to.pos).map((i) => i.pos),
    );
    cursorItemPos = Math.max(...unwrapPositions);
  }
  if (unwrapPositions.size === 0) return false;
  if (!dispatch) return true;

  const tr = state.tr;

  // Build replacement by walking items in order, splitting the list
  // around unwrapped items so position order is preserved.
  const replacement: unknown[] = [];
  let currentListItems: typeof allItems = [];
  let nextListOrder = listInfo.node.attrs.order ?? 1;
  let cursorNewPos: number | null = null;

  function flushList(listType: import('prosemirror-model').NodeType): void {
    if (currentListItems.length === 0) return;
    const nodes = currentListItems.map((i) => i.node);
    const attrs = { ...listInfo!.node.attrs, order: nextListOrder };
    replacement.push(listType.create(attrs, nodes));
    nextListOrder += nodes.length;
    currentListItems = [];
  }

  for (const item of allItems) {
    if (unwrapPositions.has(item.pos)) {
      // Flush any accumulated kept items as a list before this unwrapped item
      flushList(listInfo.node.type);
      if (item.pos === cursorItemPos) {
        let pos = listInfo.start;
        for (const n of replacement) {
          pos += (n as import('prosemirror-model').Node).nodeSize;
        }
        const contentOffset = Math.max(0, cursorOldPos - item.pos - 1);
        cursorNewPos = Math.min(pos + contentOffset, pos + item.node.nodeSize - 3);
      }
      // Emit the unwrapped item's children as blocks
      for (let j = 0; j < item.node.content.childCount; j++) {
        const child = item.node.content.child(j);
        if (child.isBlock) {
          replacement.push(child);
        } else {
          replacement.push(paragraphType.create(null, child));
        }
      }
    } else {
      currentListItems.push(item);
    }
  }
  // Flush remaining kept items
  flushList(listInfo.node.type);

  if (replacement.length === 0) return false;

  tr.replaceWith(listInfo.start, listInfo.end, replacement as never);

  if (cursorNewPos !== null) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorNewPos)));
  }

  dispatch(tr);
  return true;
}

/** Find the depth of the closest block ancestor (paragraph, heading, etc.)
 *  that contains the position, and return the [start, end) position range
 *  for replacing that block range. For AllSelection (depth 0) returns [0, docSize). */
function blockRange(
  $pos: import('prosemirror-model').ResolvedPos,
): { from: number; to: number } {
  if ($pos.depth === 0) return { from: 0, to: $pos.doc.content.size };
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).isBlock) {
      return { from: $pos.before(d), to: $pos.after(d) };
    }
  }
  return { from: $pos.start(1), to: $pos.end(1) };
}

/** Wrap each block node in the selection range individually as a list item.
 *  Fixes Bug 3 where wrapIn puts everything in a single item. */
function wrapBlocksInList(
  state: EditorState,
  listType: import('prosemirror-model').NodeType,
  dispatch?: (tr: Transaction) => void,
  listItemAttrs?: Record<string, unknown>,
): boolean {
  const schema = state.schema;
  const listItemType = schema.nodes.list_item;
  if (!listItemType || !listType) return false;

  const sel = state.selection;
  const { from: blockFrom, to: blockTo } = blockRange(sel.$from);
  const { to: blockTo2 } = blockRange(sel.$to);
  // Use the wider range between $from and $to block boundaries
  const rangeFrom = blockFrom;
  const rangeTo = Math.max(blockTo, blockTo2);

  const selectedBlocks: Array<{ node: import('prosemirror-model').Node; pos: number }> = [];
  const isListItem = (n: import('prosemirror-model').Node) => n.type === listItemType;

  state.doc.nodesBetween(rangeFrom, rangeTo, (node, pos) => {
    if (node.isBlock && node.type !== schema.nodes.doc) {
      const parent = state.doc.resolve(pos).parent;
      // Include blocks that are:
      // 1. Top-level blocks not inside any list, OR
      // 2. Blocks inside existing lists of ANY type (to support merging
      //    when rebuilding a numbered list after unwrap/reapply).
      //    Skip `list_item` and `list` wrappers themselves.
      if (!isListItem(node) && node.type !== listType) {
        if (parent.type !== listItemType && parent.type !== listType) {
          selectedBlocks.push({ node, pos });
        } else if (parent.type === listItemType) {
          // Inside an existing list item — pull the content out
          for (let j = 0; j < parent.content.childCount; j++) {
            const child = parent.content.child(j);
            if (child.isBlock) {
              selectedBlocks.push({ node: child, pos: pos + j });
            }
          }
        }
      }
    }
  });

  // Deduplicate: if a parent block is already included, skip children
  const deduped = selectedBlocks.filter((b) => {
    return !selectedBlocks.some(
      (other) => other.pos < b.pos && other.pos + other.node.nodeSize >= b.pos + b.node.nodeSize,
    );
  });

  if (deduped.length === 0) return false;
  if (!dispatch) return true;

  const cursorOldPos = state.selection.$from.pos;
  const cursorBlock = deduped.find(
    (b) => b.pos <= cursorOldPos && cursorOldPos < b.pos + b.node.nodeSize,
  );
  const cursorBlockIndex = cursorBlock ? deduped.indexOf(cursorBlock) : -1;

  const tr = state.tr;
  const listItems: unknown[] = [];

  for (const block of deduped) {
    const itemContent = listItemType.create(listItemAttrs, block.node);
    listItems.push(itemContent);
  }

  // Collect existing list items from adjacent lists of the same type
  // so they merge into one list instead of being siblings with duplicate
  // numbering (e.g. two ordered lists both showing "1").
  const allItems: unknown[] = [];
  let effectiveFrom = rangeFrom;
  let effectiveTo = rangeTo;

  if (rangeFrom > 0) {
    const nodeBefore = state.doc.resolve(rangeFrom).nodeBefore;
    if (nodeBefore && nodeBefore.type === listType) {
      effectiveFrom = rangeFrom - nodeBefore.nodeSize;
      for (let i = 0; i < nodeBefore.content.childCount; i++) {
        allItems.push(nodeBefore.content.child(i));
      }
    }
  }
  allItems.push(...listItems);
  if (rangeTo < state.doc.content.size) {
    const nodeAfter = state.doc.resolve(rangeTo).nodeAfter;
    if (nodeAfter && nodeAfter.type === listType) {
      effectiveTo = rangeTo + nodeAfter.nodeSize;
      for (let i = 0; i < nodeAfter.content.childCount; i++) {
        allItems.push(nodeAfter.content.child(i));
      }
    }
  }

  const list = listType.create(undefined, allItems as never);

  tr.replaceWith(effectiveFrom, effectiveTo, list);

  if (cursorBlock) {
    let adjacentBeforeCount = 0;
    if (rangeFrom > 0) {
      const nb = state.doc.resolve(rangeFrom).nodeBefore;
      if (nb && nb.type === listType) {
        adjacentBeforeCount = nb.content.childCount;
      }
    }
    const itemPos = adjacentBeforeCount + cursorBlockIndex;
    let itemStart = effectiveFrom + 1;
    for (let i = 0; i < itemPos; i++) {
      itemStart += (allItems[i] as import('prosemirror-model').Node).nodeSize;
    }
    const offsetInBlock = Math.max(0, cursorOldPos - cursorBlock.pos);
    tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + 1 + offsetInBlock)));
  }

  dispatch(tr);
  return true;
}

/** Switch an existing list's wrapper type (e.g. bullet_list -> ordered_list).
 *  Fixes Bug 7 where clicking a different list type silently fails. */
function switchListType(
  state: EditorState,
  targetType: import('prosemirror-model').NodeType,
  dispatch?: (tr: Transaction) => void,
  listItemAttrs?: Record<string, unknown>,
): boolean {
  const listInfo = findParentList(state);
  if (!listInfo || listInfo.node.type === targetType) return false;

  if (!dispatch) return true;

  const cursorOldPos = state.selection.$from.pos;
  const tr = state.tr;
  const items = collectListItems(state.doc, listInfo.start, listInfo.end);
  const cursorItem = items.find(
    (item) => item.pos <= cursorOldPos && cursorOldPos < item.pos + item.node.nodeSize,
  );
  const cursorOffsetInItem = cursorItem ? cursorOldPos - cursorItem.pos : -1;

  const newItems = items.map((item) => {
    const attrs = listItemAttrs ?? item.node.attrs;
    return item.node.type.create(attrs, item.node.content, item.node.marks);
  });

  const newList = targetType.create(listInfo.node.attrs, newItems);
  tr.replaceWith(listInfo.start, listInfo.end, newList);

  if (cursorItem && cursorOffsetInItem >= 0) {
    const itemIndex = items.indexOf(cursorItem);
    let itemStart = listInfo.start + 1;
    for (let i = 0; i < itemIndex; i++) {
      itemStart += items[i]!.node.nodeSize;
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + cursorOffsetInItem)));
  }

  dispatch(tr);
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
      if (currentLevel === targetLevel) {
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
      const orderedListType = state.schema.nodes.ordered_list;
      if (!bulletListType || !dispatch) return;

      if (hasTaskListAncestor(state)) {
        // Convert checklist to regular bullet list (clear checked attr)
        switchListType(state, bulletListType, dispatch, {});
      } else if (hasParentBlockType(state, bulletListType)) {
        unwrapList(state, dispatch);
      } else if (hasParentBlockType(state, orderedListType)) {
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
      const bulletListType = state.schema.nodes.bullet_list;
      if (!orderedListType || !dispatch) return;

      if (hasParentBlockType(state, orderedListType)) {
        // Check if the selection also contains top-level blocks outside
        // any list. If so, rebuild all content into one list.
        const { from, to } = state.selection;
        const listItemType = state.schema.nodes.list_item;
        let hasNonList = false;
        if (from !== to) {
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isBlock || node.type.name === 'doc') return;
            const $pos = state.doc.resolve(pos);
            // Only count nodes directly inside the document (depth 1)
            // as "non-list" — content inside list items shouldn't count.
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
      } else if (hasTaskListAncestor(state)) {
        // Convert checklist to numbered list
        switchListType(state, orderedListType, dispatch, {});
      } else if (
        hasParentBlockType(state, bulletListType) &&
        !hasTaskListAncestor(state)
      ) {
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
      if (hasTaskListAncestor(state)) {
        unwrapList(state, dispatch);
      } else if (
        hasParentBlockType(state, bulletListType) ||
        hasParentBlockType(state, state.schema.nodes.ordered_list)
      ) {
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
        if (!view || !view.hasFocus()) return;
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
