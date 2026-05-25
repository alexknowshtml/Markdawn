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

/** Collect list items at ANY depth within a position range.
 *  Used for determining which items intersect a user's selection. */
export function collectListItemsInRange(
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

/** Collect only the DIRECT children of a list node.
 *  Used by unwrapList and switchListType to operate on siblings only.
 *  This prevents nested list items from being treated as siblings of
 *  their parent's siblings (the root cause of nested-list duplication). */
export function collectDirectListItems(
  listNode: Node,
  listStart: number,
): Array<{ node: Node; pos: number }> {
  const listItemType = listNode.type.schema.nodes.list_item;
  const items: Array<{ node: Node; pos: number }> = [];
  let childPos = listStart + 1;
  for (let i = 0; i < listNode.content.childCount; i++) {
    const child = listNode.content.child(i);
    if (child.type === listItemType) {
      items.push({ node: child, pos: childPos });
    }
    childPos += child.nodeSize;
  }
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

  // Only direct children — nested items stay encapsulated within their
  // parent's content and are NOT unwrapped individually. This prevents
  // the duplication bug where nested items were extracted as siblings.
  const allItems = collectDirectListItems(listInfo.node, listInfo.start);

  // Determine which items to unwrap.
  // Collapsed selection: unwrap just the item under cursor.
  // Non-empty selection: unwrap all DIRECT items intersecting the range.
  // We filter allItems (direct children) by overlap with the selection
  // rather than using collectListItemsInRange (which would include
  // nested descendants as if they were siblings).
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
    unwrapPositions = new Set(
      allItems
        .filter((item) => item.pos < $to.pos && item.pos + item.node.nodeSize > $from.pos)
        .map((i) => i.pos),
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
      // Emit the unwrapped item's children as blocks first, so cursorNewPos
      // can use the actual replacement size rather than the old node's size.
      const replaceStart = replacement.length;
      for (let j = 0; j < item.node.content.childCount; j++) {
        const child = item.node.content.child(j);
        if (child.isBlock) {
          replacement.push(child);
        } else {
          replacement.push(paragraphType.create(null, child));
        }
      }
      if (item.pos === cursorItemPos) {
        let pos = listInfo.start;
        for (const n of replacement) {
          pos += (n as Node).nodeSize;
        }
        const contentOffset = Math.max(0, cursorOldPos - item.pos - 1);
        let replaceSize = 0;
        for (let i = replaceStart; i < replacement.length; i++) {
          replaceSize += (replacement[i] as Node).nodeSize;
        }
        const itemContentStart = pos - replaceSize;
        cursorNewPos = Math.min(itemContentStart + contentOffset, pos - 1);
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
  const paragraphType = schema.nodes.paragraph;
  if (!listItemType || !listType || !paragraphType) return false;

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
      const $pos = state.doc.resolve(pos);
      const parent = $pos.parent;
      // Include blocks that are:
      // 1. Top-level blocks not inside any list, OR
      // 2. Blocks directly inside a list_item that is itself top-level
      //    (not nested inside another list). Nested-list blocks are
      //    excluded because they are descendants of the parent list_item
      //    and extracting them as separate items would break nesting.
      if (!isListItem(node) && node.type !== listType) {
        if (parent.type !== listItemType && parent.type !== listType) {
          selectedBlocks.push({ node, pos });
        } else if (parent.type === listItemType) {
          // Only include blocks that are DIRECT children of a top-level
          // list_item. Blocks inside nested lists (list_item's whose
          // ancestor chain includes another list_item above depth 1)
          // are part of the nested structure and must not be extracted.
          let inNestedList = false;
          const parentDepth = $pos.depth - 1;
          for (let d = parentDepth - 1; d > 0; d--) {
            if ($pos.node(d).type === listItemType) {
              inNestedList = true;
              break;
            }
          }
          if (!inNestedList) {
            selectedBlocks.push({ node, pos });
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
    // Normalize: list_item content is "paragraph block*", so the first
    // child must be a paragraph. Convert non-paragraph blocks (headings,
    // code_blocks, etc.) to paragraphs to keep the schema valid.
    const wrapContent =
      block.node.type === paragraphType
        ? block.node
        : paragraphType.create(null, block.node.content);
    const itemContent = listItemType.create(listItemAttrs, wrapContent);
    listItems.push(itemContent);
  }

  // Collect existing list items from adjacent lists of the same type
  // so they merge into one list instead of being siblings with duplicate
  // numbering (e.g. two ordered lists both showing "1").
  const allItems: unknown[] = [];
  let effectiveFrom = rangeFrom;
  let effectiveTo = rangeTo;
  // Preserve attrs (e.g. order) from the adjacent list when merging
  let adjacentAttrs: Record<string, unknown> | undefined;

  if (rangeFrom > 0) {
    const nodeBefore = state.doc.resolve(rangeFrom).nodeBefore;
    if (nodeBefore && nodeBefore.type === listType) {
      effectiveFrom = rangeFrom - nodeBefore.nodeSize;
      adjacentAttrs = { ...nodeBefore.attrs };
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
      adjacentAttrs ??= { ...nodeAfter.attrs };
      for (let i = 0; i < nodeAfter.content.childCount; i++) {
        allItems.push(nodeAfter.content.child(i));
      }
    }
  }

  const list = listType.create(adjacentAttrs ?? undefined, allItems as never);

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

/** Return the type of the closest (innermost) list containing the cursor.
 *  'task' is returned when the closest list is a bullet_list whose direct
 *  child list_item (under the cursor) has a checked attribute — indicating
 *  a checklist/task item. Returns null when not inside any list. */
export type ClosestListType = 'bullet' | 'ordered' | 'task' | null;

export function getClosestListType(state: EditorState): ClosestListType {
  const listInfo = findParentList(state);
  if (!listInfo) return null;
  if (listInfo.node.type.name === 'ordered_list') return 'ordered';
  if (listInfo.node.type.name === 'bullet_list') {
    const listItemType = state.schema.nodes.list_item;
    if (!listItemType) return 'bullet';
    const { $from } = state.selection;
    if ($from.depth === 0) {
      // AllSelection: scan direct children of the found list for task items.
      // The normal ancestor-walking loop won't execute when depth is 0,
      // so we check the list's direct children instead.
      const items = collectDirectListItems(listInfo.node, listInfo.start);
      if (items.some((item) => item.node.attrs.checked != null)) return 'task';
      return 'bullet';
    }
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === listItemType && node.attrs.checked != null) {
        if ($from.node(d - 1) === listInfo.node) return 'task';
        break;
      }
    }
    return 'bullet';
  }
  return null;
}

/** Switch an existing list's wrapper type (e.g. bullet_list -> ordered_list). */
export function switchListType(
  state: EditorState,
  targetType: NodeType,
  dispatch?: (tr: Transaction) => void,
  listItemAttrs?: Record<string, unknown>,
): boolean {
  const listInfo = findParentList(state);
  if (!listInfo) return false;
  // When listItemAttrs is provided (e.g. toggling checked state on task
  // lists), allow same-type processing — the wrapper stays the same but
  // list-item attrs need updating.
  if (listInfo.node.type === targetType && !listItemAttrs) return false;

  if (!dispatch) return true;

  const cursorOldPos = state.selection.$from.pos;
  const tr = state.tr;
  // Only direct children — switching the wrapper type should not flatten
  // nested lists. Each item's content (including any nested sub-lists) is
  // preserved via item.node.content.
  const items = collectDirectListItems(listInfo.node, listInfo.start);
  const cursorItem = items.find(
    (item) => item.pos <= cursorOldPos && cursorOldPos < item.pos + item.node.nodeSize,
  );
  const cursorOffsetInItem = cursorItem ? cursorOldPos - cursorItem.pos : -1;

  const newItems = items.map((item) => {
    // When the wrapper type changes (e.g. ordered → bullet), reset list-item
    // attrs to schema defaults. Retaining type-specific attrs (like Milkdown's
    // `listType: 'ordered'` or `label: '1.'`) inside a different list type
    // causes rendering inconsistencies — the editor still treats them as the
    // old type. When listItemAttrs is explicitly provided (task conversion),
    // use those instead.
    const attrs = listItemAttrs ?? (listInfo.node.type !== targetType ? {} : item.node.attrs);
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
