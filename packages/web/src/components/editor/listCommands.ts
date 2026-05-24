import type { Node, NodeType } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';

export function hasTaskListAncestor(state: EditorState): boolean {
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

export function findParentList(
  state: EditorState,
): { node: Node; start: number; end: number } | null {
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

export function collectListItems(
  doc: Node,
  from: number,
  to: number,
): Array<{ node: Node; pos: number }> {
  const listItemType = doc.type.schema.nodes.list_item;
  const items: Array<{ node: Node; pos: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === listItemType) {
      items.push({ node, pos });
    }
  });
  return items;
}

/** Find the depth of the closest block ancestor (paragraph, heading, etc.)
 *  that contains the position, and return the [start, end) position range
 *  for replacing that block range. For AllSelection (depth 0) returns [0, docSize). */
export function blockRange($pos: import('prosemirror-model').ResolvedPos): {
  from: number;
  to: number;
} {
  if ($pos.depth === 0) return { from: 0, to: $pos.doc.content.size };
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).isBlock) {
      return { from: $pos.before(d), to: $pos.after(d) };
    }
  }
  return { from: $pos.start(1), to: $pos.end(1) };
}

/** Unwrap only the list items that intersect with the selection.
 *  Items outside the selection remain in the list. */
export function unwrapList(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
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
  const cursorOldPos = $from.pos;
  if ($from.pos === $to.pos) {
    const cursorItem = allItems.find(
      (item) => item.pos <= $from.pos && $from.pos < item.pos + item.node.nodeSize,
    );
    if (!cursorItem) return false;
    cursorItemPos = cursorItem.pos;
    unwrapPositions = new Set([cursorItemPos]);
  } else {
    unwrapPositions = new Set(collectListItems(state.doc, $from.pos, $to.pos).map((i) => i.pos));
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

  function flushList(listType: NodeType): void {
    if (currentListItems.length === 0) return;
    const nodes = currentListItems.map((i) => i.node);
    if (!listInfo) return;
    const attrs = { ...listInfo.node.attrs, order: nextListOrder };
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
          pos += (n as Node).nodeSize;
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

/** Wrap each block node in the selection range individually as a list item.
 *  Fixes Bug 3 where wrapIn puts everything in a single item. */
export function wrapBlocksInList(
  state: EditorState,
  listType: NodeType,
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

  const selectedBlocks: Array<{ node: Node; pos: number }> = [];
  const isListItem = (n: Node) => n.type === listItemType;

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
      itemStart += (allItems[i] as Node).nodeSize;
    }
    const offsetInBlock = Math.max(0, cursorOldPos - cursorBlock.pos);
    tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + 1 + offsetInBlock)));
  }

  dispatch(tr);
  return true;
}

/** Switch an existing list's wrapper type (e.g. bullet_list -> ordered_list). */
export function switchListType(
  state: EditorState,
  targetType: NodeType,
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
      const item = items[i];
      if (item) itemStart += item.node.nodeSize;
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + cursorOffsetInItem)));
  }

  dispatch(tr);
  return true;
}
