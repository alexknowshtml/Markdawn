import { Schema } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  blockRange,
  collectDirectListItems,
  collectListItemsInRange,
  findParentList,
  getClosestListType,
  hasTaskListAncestor,
  switchListType,
  unwrapList,
  wrapBlocksInList,
} from './listCommands';

// ---- Test Schema ----
// Matches Milkdown's node names used in the editor commands.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
    },
    text: { group: 'inline' },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
    },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null } },
    },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { level: { default: 1 } },
    },
  },
  marks: {},
});

// ---- Doc builders ----

function p(text: string) {
  return schema.node('paragraph', null, schema.text(text));
}

function li(
  content: string,
  checked: 'task' | null = null,
  ...children: ReturnType<typeof schema.node>[]
) {
  const attrs = checked === 'task' ? { checked: false } : null;
  return schema.node('list_item', attrs, [p(content), ...children]);
}

function ul(...items: ReturnType<typeof li>[]) {
  return schema.node('bullet_list', null, items);
}

function ol(...items: ReturnType<typeof li>[]) {
  return schema.node('ordered_list', null, items);
}

function doc(...children: ReturnType<typeof schema.node>[]) {
  return schema.node('doc', null, children);
}

function h(level: number, text: string) {
  return schema.node('heading', { level }, schema.text(text));
}

// ---- State helpers ----

/** Create an EditorState with the given doc, optionally placing the cursor. */
function stateWithDoc(docNode: ReturnType<typeof doc>, cursorPos?: number): EditorState {
  return EditorState.create({
    schema,
    doc: docNode,
    ...(cursorPos != null ? { selection: TextSelection.create(docNode, cursorPos) } : {}),
  });
}

/** Apply a command; throws if the command returns false (cannot be applied). */
function applyCommand(
  state: EditorState,
  command: (st: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
): EditorState {
  let newState: EditorState | undefined;
  const result = command(state, (tr) => {
    newState = state.apply(tr);
  });
  if (!result || !newState) throw new Error('Command could not be applied');
  return newState;
}

/** Count occurrences of a node type by name in the doc. */
function countNodes(state: EditorState, typeName: string): number {
  let count = 0;
  state.doc.descendants((node) => {
    if (node.type.name === typeName) count++;
  });
  return count;
}

/** Collect text content of all nodes of a given type, in order. */
function nodeTexts(state: EditorState, typeName: string): string[] {
  const texts: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === typeName) {
      texts.push(node.textContent);
    }
  });
  return texts;
}

// ---- Reusable helpers ----

function posInListItem(docNode: ReturnType<typeof doc>, text: string): number {
  let pos = -1;
  docNode.descendants((node, p) => {
    if (node.type.name === 'paragraph' && node.textContent === text) {
      pos = p + 1;
    }
  });
  return pos;
}

// ============================================================
//  hasTaskListAncestor
// ============================================================
describe('hasTaskListAncestor', () => {
  it('returns true when cursor is inside a task list item', () => {
    const state = stateWithDoc(
      doc(ul(li('task item', 'task'))),
      3, // inside "task item"
    );
    expect(hasTaskListAncestor(state)).toBe(true);
  });

  it('returns false when cursor is inside a regular list item', () => {
    const state = stateWithDoc(doc(ul(li('regular'))), 3);
    expect(hasTaskListAncestor(state)).toBe(false);
  });

  it('returns false when not in a list', () => {
    const state = stateWithDoc(doc(p('plain text')), 3);
    expect(hasTaskListAncestor(state)).toBe(false);
  });
});

// ============================================================
//  findParentList
// ============================================================
describe('findParentList', () => {
  it('finds the parent bullet list from inside a list item', () => {
    const myDoc = doc(ul(li('alpha'), li('beta')), p('after'));
    const state = stateWithDoc(myDoc, 3); // inside "alpha"
    const info = findParentList(state);
    expect(info).not.toBeNull();
    expect(info?.node.type.name).toBe('bullet_list');
    // ProseMirror positions are 0-based: first child of doc starts at 0
    expect(info?.start).toBe(0);
    expect(info?.end).toBe(myDoc.content.child(0).nodeSize);
  });

  it('finds the parent ordered list from inside a list item', () => {
    const myDoc = doc(ol(li('one'), li('two')));
    const state = stateWithDoc(myDoc, 3); // inside "one"
    const info = findParentList(state);
    expect(info).not.toBeNull();
    expect(info?.node.type.name).toBe('ordered_list');
  });

  it('returns null when not in a list', () => {
    const state = stateWithDoc(doc(p('text')), 3);
    expect(findParentList(state)).toBeNull();
  });
});

// ============================================================
//  collectListItemsInRange
// ============================================================
describe('collectListItemsInRange', () => {
  it('returns all list items within a range', () => {
    const myDoc = doc(ul(li('a'), li('b'), li('c')));
    const state = stateWithDoc(myDoc);
    const items = collectListItemsInRange(state.doc, 1, state.doc.content.size);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.node.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('returns items intersecting a partial range', () => {
    const myDoc = doc(ul(li('a'), li('b'), li('c')));
    const state = stateWithDoc(myDoc);
    let bPos = -1;
    let bSize = -1;
    myDoc.descendants((node, pos) => {
      if (node.textContent === 'b' && node.type.name === 'list_item') {
        bPos = pos;
        bSize = node.nodeSize;
      }
    });
    expect(bPos).not.toBe(-1);
    const items = collectListItemsInRange(state.doc, bPos, bPos + bSize);
    expect(items).toHaveLength(1);
    expect(items[0]?.node.textContent).toBe('b');
  });

  it('returns items at ALL depths including nested', () => {
    const myDoc = doc(ul(li('Outer A', null, ul(li('Inner 1'), li('Inner 2'))), li('Outer B')));
    const state = stateWithDoc(myDoc);
    const items = collectListItemsInRange(state.doc, 1, state.doc.content.size);
    // Should find all 4 items (Outer A, Inner 1, Inner 2, Outer B)
    // because this function traverses ALL descendants
    expect(items).toHaveLength(4);
    // node.textContent includes nested children's text — Outer A's item
    // contains "Inner 1" and "Inner 2" text from its nested sub-list
    const textContents = items.map((i) => i.node.textContent);
    expect(textContents[0]).toContain('Outer A');
    expect(textContents).toContain('Inner 1');
    expect(textContents).toContain('Inner 2');
    expect(textContents).toContain('Outer B');
  });
});

// ============================================================
//  collectDirectListItems
// ============================================================
describe('collectDirectListItems', () => {
  it('returns only direct children of a flat list', () => {
    const myDoc = doc(ul(li('a'), li('b'), li('c')));
    const listNode = myDoc.content.child(0);
    // First child starts at position 1 (after the list opening)
    const items = collectDirectListItems(listNode, 0);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.node.textContent)).toEqual(['a', 'b', 'c']);
    // Positions should be sequential: list starts at 0, first child at 1
    expect(items[0]?.pos).toBe(1);
  });

  it('returns only direct children excluding nested items', () => {
    // Critical: collectDirectListItems must NOT include nested items
    const nested = ul(li('Inner 1'), li('Inner 2'));
    const myDoc = doc(ul(li('Outer A', null, nested), li('Outer B')));
    const listNode = myDoc.content.child(0); // outer bullet_list
    const items = collectDirectListItems(listNode, 0);
    expect(items).toHaveLength(2);
    const textContents = items.map((i) => i.node.textContent);
    expect(textContents[0]).toContain('Outer A');
    expect(textContents[1]).toBe('Outer B');
  });

  it('computes correct positions for direct children', () => {
    const nested = ul(li('Inner'));
    // Outer A has: paragraph + nested ul → larger nodeSize than Outer B
    const myDoc = doc(ul(li('Outer A', null, nested), li('Outer B')));
    const listNode = myDoc.content.child(0);
    const items = collectDirectListItems(listNode, 0);
    expect(items).toHaveLength(2);
    // Outer B should start after Outer A's full nodeSize
    const item0 = items[0];
    const item1 = items[1];
    expect(item1?.pos).toBe((item0?.pos ?? 0) + (item0?.node.nodeSize ?? 0));
  });
});

// ============================================================
//  blockRange
// ============================================================
describe('blockRange', () => {
  it('returns paragraph boundaries from within a paragraph', () => {
    const myDoc = doc(p('hello world'), p('second'));
    const state = stateWithDoc(myDoc, 6);
    const range = blockRange(state.selection.$from);
    // First paragraph starts at 0 (0-based), ends at its nodeSize
    const firstPara = myDoc.content.child(0);
    expect(range.from).toBe(0);
    expect(range.to).toBe(firstPara.nodeSize);
  });

  it('returns heading boundaries from within a heading', () => {
    const myDoc = doc(h(2, 'heading'), p('text'));
    const state = stateWithDoc(myDoc, 3);
    const range = blockRange(state.selection.$from);
    const headingNode = myDoc.content.child(0);
    expect(range.from).toBe(0);
    expect(range.to).toBe(headingNode.nodeSize);
  });
});

// ============================================================
//  switchListType  —  Nested-list scenarios
// ============================================================
describe('switchListType with nested lists', () => {
  function nestedDoc() {
    return doc(ul(li('Outer A', null, ul(li('Inner 1'), li('Inner 2'))), li('Outer B')));
  }

  it('switches inner list type without affecting outer list', () => {
    const myDoc = nestedDoc();
    const innerPos = posInListItem(myDoc, 'Inner 1');
    expect(innerPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, innerPos);
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, orderedList, dispatch),
    );

    // Inner list should now be ordered
    const orderedLists = new Array<{ order?: number }>();
    newState.doc.descendants((node) => {
      if (node.type.name === 'ordered_list') orderedLists.push({ order: node.attrs.order });
    });
    expect(orderedLists).toHaveLength(1);
    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(nodeTexts(newState, 'list_item')).toContain('Inner 1');
    expect(nodeTexts(newState, 'list_item')).toContain('Inner 2');
  });

  it('switches outer list type without flattening inner list', () => {
    const myDoc = nestedDoc();
    const outerBPos = posInListItem(myDoc, 'Outer B');
    expect(outerBPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, outerBPos);
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, orderedList, dispatch),
    );

    expect(countNodes(newState, 'ordered_list')).toBe(1);
    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(countNodes(newState, 'list_item')).toBe(4); // Outer A + Inner 1 + Inner 2 + Outer B
    // Inner list should still have 2 items
    let innerItemCount = 0;
    newState.doc.descendants((node) => {
      if (node.type.name === 'bullet_list') {
        node.descendants((child) => {
          if (child.type.name === 'list_item') innerItemCount++;
        });
      }
    });
    expect(innerItemCount).toBe(2);
  });

  it('converts task list nested inside bullet list', () => {
    const myDoc = doc(ul(li('Regular'), li('Task', 'task', ul(li('Nested Task', 'task')))));
    const taskPos = posInListItem(myDoc, 'Task');
    expect(taskPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, taskPos);
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, orderedList, dispatch, {}),
    );

    expect(countNodes(newState, 'ordered_list')).toBe(1);
    // Nested task list item should still have checked state
    let nestedChecked = false;
    newState.doc.descendants((node) => {
      if (node.type.name === 'list_item' && node.attrs.checked === false) {
        nestedChecked = true;
      }
    });
    expect(nestedChecked).toBe(true);
  });
});

// ============================================================
//  switchListType  —  Regression tests for Bug 7
// ============================================================
describe('unwrapList', () => {
  it('unwraps only the selected item in a multi-item list (collapsed selection)', () => {
    // Bug 1: toggling list off on one item should not affect others
    const myDoc = doc(ul(li('First'), li('Second'), li('Third')));
    const state = stateWithDoc(myDoc, 10); // inside "Second"

    const newState = applyCommand(state, unwrapList);
    // "Second" should now be a paragraph; "First" and "Third" remain in lists
    const paras = nodeTexts(newState, 'paragraph');
    const lists = countNodes(newState, 'bullet_list');

    expect(paras).toContain('Second');
    expect(lists).toBe(2); // Two separate lists around the unwrapped item
  });

  it('unwraps only the first item when cursor is in the first item', () => {
    const myDoc = doc(ul(li('First'), li('Second'), li('Third')));
    const state = stateWithDoc(myDoc, 3); // inside "First"

    const newState = applyCommand(state, unwrapList);

    const paras = nodeTexts(newState, 'paragraph');
    expect(paras).toContain('First');
    // Remaining two items should still be in a list
    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(countNodes(newState, 'list_item')).toBe(2);
  });

  it('unwraps only the last item when cursor is in the last item', () => {
    const myDoc = doc(ul(li('First'), li('Second'), li('Third')));
    const state = stateWithDoc(myDoc, 19); // inside "Third"

    const newState = applyCommand(state, unwrapList);

    const paras = nodeTexts(newState, 'paragraph');
    expect(paras).toContain('Third');
    expect(countNodes(newState, 'list_item')).toBe(2);
  });

  it('unwrapping the only item in a single-item list produces a paragraph', () => {
    const myDoc = doc(ul(li('Solo')));
    const state = stateWithDoc(myDoc, 3);

    const newState = applyCommand(state, unwrapList);

    expect(countNodes(newState, 'bullet_list')).toBe(0);
    expect(countNodes(newState, 'list_item')).toBe(0);
    expect(nodeTexts(newState, 'paragraph')).toContain('Solo');
  });

  it('unwraps multiple items when selection spans them', () => {
    const myDoc = doc(ul(li('First'), li('Second'), li('Third'), li('Fourth')));
    // Create a state with selection spanning "Second" and "Third"
    const startPos = 8; // start of "Second"
    const endPos = 20; // end of "Third"
    const state = EditorState.create({
      schema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, startPos, endPos),
    });

    const newState = applyCommand(state, unwrapList);

    const paras = nodeTexts(newState, 'paragraph');
    expect(paras).toContain('Second');
    expect(paras).toContain('Third');
    // First and Fourth should remain as list items
    expect(countNodes(newState, 'list_item')).toBe(2);
  });

  it('returns false when not in a list', () => {
    const state = stateWithDoc(doc(p('text')));
    expect(unwrapList(state)).toBe(false);
  });

  it('preserves cursor position after unwrapping a list item', () => {
    // Regression: cursor cap used Math.min(pos + contentOffset, pos) which
    // always resolves to pos (contentOffset >= 0), landing the cursor at
    // the end instead of preserving the old offset.
    const myDoc = doc(ul(li('alpha')));
    // Position 4 is inside "alpha" at "a[l]pha"
    const state = stateWithDoc(myDoc, 4);
    const newState = applyCommand(state, unwrapList);
    // The cursor should be near position 4 (start of "alpha") + offset,
    // not at the end of the unwrapped content.
    const $sel = newState.selection.$from;
    // The resolved position should still land inside "alpha"
    expect(newState.doc.textBetween($sel.before(), $sel.after())).toBe('alpha');
  });

  it('preserves ordered list numbering when unwrapping a middle item', () => {
    // Regression: nextListOrder wasn't incremented for unwrapped items,
    // causing the tail list to restart at the wrong number.
    const myDoc = doc(
      schema.node('ordered_list', { order: 3 }, [li('First'), li('Second'), li('Third')]),
    );
    const state = stateWithDoc(myDoc, 10); // inside "Second"
    const newState = applyCommand(state, unwrapList);
    // Should have two ordered lists: one with [First] at order 3, one
    // with [Third] at order 5 (Second was #4 in the original sequence).
    const lists: Array<{ order: number; texts: string[] }> = [];
    newState.doc.descendants((node) => {
      if (node.type.name === 'ordered_list') {
        const texts: string[] = [];
        node.descendants((child) => {
          if (child.type.name === 'list_item') texts.push(child.textContent);
        });
        lists.push({ order: node.attrs.order as number, texts });
      }
    });
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual({ order: 3, texts: ['First'] });
    expect(lists[1]).toEqual({ order: 4, texts: ['Third'] });
  });
});

// ============================================================
//  getClosestListType
// ============================================================
describe('getClosestListType', () => {
  it('returns null when not in a list', () => {
    const state = stateWithDoc(doc(p('text')), 3);
    expect(getClosestListType(state)).toBeNull();
  });

  it('returns bullet for flat bullet list', () => {
    const state = stateWithDoc(doc(ul(li('item'))), 3);
    expect(getClosestListType(state)).toBe('bullet');
  });

  it('returns ordered for flat ordered list', () => {
    const state = stateWithDoc(doc(ol(li('item'))), 3);
    expect(getClosestListType(state)).toBe('ordered');
  });

  it('returns task for task list item', () => {
    const state = stateWithDoc(doc(ul(li('task', 'task'))), 3);
    expect(getClosestListType(state)).toBe('task');
  });

  it('returns inner list type in nested context (bullet > ordered)', () => {
    const myDoc = doc(ul(li('Outer', null, ol(li('Inner')))));
    let innerPos = -1;
    myDoc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Inner') {
        innerPos = pos + 1;
      }
    });
    expect(innerPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, innerPos);
    expect(getClosestListType(state)).toBe('ordered');
  });

  it('returns inner list type in nested context (ordered > bullet)', () => {
    const myDoc = doc(ol(li('Outer', null, ul(li('Inner')))));
    let innerPos = -1;
    myDoc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Inner') {
        innerPos = pos + 1;
      }
    });
    expect(innerPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, innerPos);
    expect(getClosestListType(state)).toBe('bullet');
  });
});

// ============================================================
//  wrapBlocksInList  —  Regression tests for Bug 3
// ============================================================
describe('wrapBlocksInList', () => {
  it('wraps each selected paragraph as a separate list item', () => {
    // Bug 3: selecting multiple paragraphs should create individual list items
    const myDoc = doc(p('Alpha'), p('Beta'), p('Gamma'));
    const state = EditorState.create({
      schema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, 1, myDoc.content.size),
    });
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );

    // Should have 3 list items
    expect(countNodes(newState, 'list_item')).toBe(3);
    const items = nodeTexts(newState, 'list_item');
    expect(items).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('wraps a single paragraph as one list item', () => {
    const myDoc = doc(p('Only one'));
    const state = stateWithDoc(myDoc, 1);
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );
    expect(newState).not.toBeNull();
    expect(countNodes(newState, 'list_item')).toBe(1);
    expect(nodeTexts(newState, 'list_item')).toEqual(['Only one']);
  });

  it('wraps the current paragraph when cursor has no explicit selection range', () => {
    // A collapsed cursor inside a paragraph still counts as "in the block"
    const myDoc = doc(p('text'));
    const state = stateWithDoc(myDoc, 3);
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );
    expect(newState).not.toBeNull();
    expect(countNodes(newState, 'list_item')).toBe(1);
  });

  it('extracts blocks from inside existing list items without duplication', () => {
    // Regression: inner-loop position arithmetic (pos + j, where j is an
    // array index) produced wrong positions and duplicated sibling blocks.
    const multiBlockItem = schema.node('list_item', null, [p('Alpha'), p('Beta')]);
    const myDoc = doc(schema.node('bullet_list', null, [multiBlockItem]), p('Gamma'));
    const state = EditorState.create({
      schema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, 1, myDoc.content.size),
    });
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );

    // All three blocks should become individual list items
    expect(countNodes(newState, 'list_item')).toBe(3);
    expect(nodeTexts(newState, 'list_item')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('preserves order attribute from adjacent ordered list when merging', () => {
    // Regression: listType.create(undefined, ...) discards attrs like
    // order, causing the merged list to restart at 1.
    const myDoc = doc(schema.node('ordered_list', { order: 3 }, [li('Existing')]), p('New item'));
    const paraStart = myDoc.content.child(0).nodeSize;
    const state = stateWithDoc(myDoc, paraStart + 2); // cursor in "New item"
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, orderedList, dispatch),
    );

    let mergedOrder: number | undefined;
    newState.doc.descendants((node) => {
      if (node.type.name === 'ordered_list') {
        mergedOrder = node.attrs.order as number;
      }
    });
    expect(mergedOrder).toBe(3);
  });

  it('normalises a heading to a paragraph when wrapping in a list item', () => {
    // Regression: wrapping a heading directly in list_item violates the
    // schema (list_item content is "paragraph block*"). The block should
    // be converted to a paragraph while preserving inline content.
    const myDoc = doc(h(2, 'Important heading'), p('body text'));
    const state = EditorState.create({
      schema,
      doc: myDoc,
      // Select the entire document
      selection: TextSelection.create(myDoc, 1, myDoc.content.size),
    });
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );

    // Should have 2 list items
    expect(countNodes(newState, 'list_item')).toBe(2);
    // The heading text should be preserved
    expect(nodeTexts(newState, 'list_item')).toEqual(['Important heading', 'body text']);
    // The list should not contain any heading nodes
    let headingCount = 0;
    newState.doc.descendants((node) => {
      if (node.type.name === 'heading') headingCount++;
    });
    expect(headingCount).toBe(0);
  });

  it('does not create duplicate list items when extracting blocks from inside a list item with multi-block range', () => {
    // The nodesBetween callback visits each block inside the list_item.
    // Without the fix it pushes every child of the parent list_item for
    // EACH visit, producing duplicates.
    const multiBlockItem = schema.node('list_item', null, [p('Alpha'), p('Beta')]);
    const myDoc = doc(schema.node('bullet_list', null, [multiBlockItem]), p('Gamma'));
    const state = EditorState.create({
      schema,
      doc: myDoc,
      // Range spanning the entire doc
      selection: TextSelection.create(myDoc, 1, myDoc.content.size),
    });
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      wrapBlocksInList(st, bulletList, dispatch),
    );

    // Should have exactly 3 list items (Alpha, Beta, Gamma), no duplicates
    expect(countNodes(newState, 'list_item')).toBe(3);
    expect(nodeTexts(newState, 'list_item')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

// ============================================================
//  unwrapList  —  Nested-list scenarios
// ============================================================
describe('unwrapList with nested lists', () => {
  function nestedDoc() {
    return doc(ul(li('Outer A', null, ul(li('Inner 1'), li('Inner 2'))), li('Outer B')));
  }

  it('unwraps innermost item without affecting outer structure', () => {
    const myDoc = nestedDoc();
    const innerStart = posInListItem(myDoc, 'Inner 1');
    expect(innerStart).not.toBe(-1);
    const state = stateWithDoc(myDoc, innerStart);

    const newState = applyCommand(state, unwrapList);

    // "Inner 1" should now be a paragraph (removed from inner list)
    expect(nodeTexts(newState, 'paragraph')).toContain('Inner 1');
    // "Inner 2" should still be a list item in the inner list
    expect(nodeTexts(newState, 'list_item')).toContain('Inner 2');
    // Outer structure should remain intact
    expect(countNodes(newState, 'bullet_list')).toBe(2); // outer + inner
  });

  it('unwraps outermost item preserving nested content', () => {
    const myDoc = nestedDoc();
    const outerStart = posInListItem(myDoc, 'Outer A');
    expect(outerStart).not.toBe(-1);
    const state = stateWithDoc(myDoc, outerStart);

    const newState = applyCommand(state, unwrapList);

    expect(nodeTexts(newState, 'paragraph')).toContain('Outer A');
    expect(nodeTexts(newState, 'list_item')).toEqual(['Inner 1', 'Inner 2', 'Outer B']);
    expect(countNodes(newState, 'bullet_list')).toBe(2);
  });

  it('does not duplicate nested items when unwrapping a sibling', () => {
    const myDoc = nestedDoc();
    const outerBPos = posInListItem(myDoc, 'Outer B');
    expect(outerBPos).not.toBe(-1);
    const state = stateWithDoc(myDoc, outerBPos);

    const newState = applyCommand(state, unwrapList);

    expect(nodeTexts(newState, 'paragraph')).toContain('Outer B');
    const innerItems = nodeTexts(newState, 'list_item');
    expect(innerItems.filter((t) => t === 'Inner 1')).toHaveLength(1);
    expect(innerItems.filter((t) => t === 'Inner 2')).toHaveLength(1);
    expect(countNodes(newState, 'list_item')).toBe(3);
  });

  it('preserves three-level nesting structure', () => {
    const triple = doc(ul(li('A', null, ul(li('B', null, ul(li('C')))))));
    const cPos = posInListItem(triple, 'C');
    expect(cPos).not.toBe(-1);
    const state = stateWithDoc(triple, cPos);

    const newState = applyCommand(state, unwrapList);

    expect(nodeTexts(newState, 'paragraph')).toContain('C');
    // B and A remain as list_items (their textContent includes descendants)
    expect(nodeTexts(newState, 'list_item')).toHaveLength(2);
    // The inner list (containing C) was removed — only outer + middle remain
    expect(countNodes(newState, 'bullet_list')).toBe(2);
  });

  it('unwraps multiple direct items when selection spans them (no nested duplication)', () => {
    const myDoc = doc(ul(li('First'), li('Second', null, ul(li('Nested'))), li('Third')));
    // Select from start of First's paragraph to end of Third's paragraph
    const firstPara = posInListItem(myDoc, 'First');
    let thirdParaEnd = -1;
    myDoc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Third') {
        thirdParaEnd = pos + node.nodeSize;
      }
    });
    expect(firstPara).not.toBe(-1);
    expect(thirdParaEnd).not.toBe(-1);

    // Use a text selection that spans from First paragraph to end of Third paragraph
    const state = EditorState.create({
      schema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, firstPara - 1, thirdParaEnd),
    });
    const newState = applyCommand(state, unwrapList);

    expect(nodeTexts(newState, 'paragraph')).toContain('First');
    expect(nodeTexts(newState, 'paragraph')).toContain('Second');
    expect(nodeTexts(newState, 'paragraph')).toContain('Third');
    expect(nodeTexts(newState, 'list_item')).toEqual(['Nested']);
    expect(countNodes(newState, 'bullet_list')).toBe(1);
  });
});

// ============================================================
//  wrapBlocksInList  —  Regression tests for Bug 3
// ============================================================
describe('switchListType', () => {
  it('converts a bullet list to an ordered list', () => {
    const myDoc = doc(ul(li('First'), li('Second')));
    const state = stateWithDoc(myDoc, 3);
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, orderedList, dispatch),
    );

    expect(countNodes(newState, 'ordered_list')).toBe(1);
    expect(countNodes(newState, 'bullet_list')).toBe(0);
    expect(nodeTexts(newState, 'list_item')).toEqual(['First', 'Second']);
  });

  it('converts an ordered list to a bullet list', () => {
    const myDoc = doc(ol(li('One'), li('Two')));
    const state = stateWithDoc(myDoc, 3);
    const bulletList = schema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, bulletList, dispatch),
    );

    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(countNodes(newState, 'ordered_list')).toBe(0);
    expect(nodeTexts(newState, 'list_item')).toEqual(['One', 'Two']);
  });

  it('returns false when already the target type', () => {
    const myDoc = doc(ul(li('Item')));
    const state = stateWithDoc(myDoc, 3);
    const bulletList = schema.nodes.bullet_list;

    expect(switchListType(state, bulletList)).toBe(false);
  });

  it('updates list-item attrs when target type matches and attrs provided', () => {
    // Regression: toolbar calls switchListType(bullet, dispatch, taskAttrs)
    // to convert a regular bullet list to a task list. The early return
    // on same-type blocked it even though list_item attrs need updating.
    const myDoc = doc(ul(li('Item')));
    const state = stateWithDoc(myDoc, 3);
    const bulletList = schema.nodes.bullet_list;
    const taskAttrs = { checked: false };

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, bulletList, dispatch, taskAttrs),
    );

    // Wrapper should still be a bullet list
    expect(countNodes(newState, 'bullet_list')).toBe(1);
    // List items should have checked = false (task list)
    let hasChecked = false;
    newState.doc.descendants((node) => {
      if (node.type.name === 'list_item' && node.attrs.checked === false) {
        hasChecked = true;
      }
    });
    expect(hasChecked).toBe(true);
  });

  it('converts ordered to bullet with Milkdown-style attrs (spread)', () => {
    // Milkdown adds a `spread` attr to both bullet_list and ordered_list.
    // This test verifies that switchListType handles attrs correctly when the
    // target type has fewer defined attrs than the source type.
    const milkdownLikeSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
        bullet_list: {
          content: 'list_item+',
          group: 'block',
          attrs: { spread: { default: false } },
        },
        ordered_list: {
          content: 'list_item+',
          group: 'block',
          attrs: { order: { default: 1 }, spread: { default: false } },
        },
        list_item: {
          content: 'paragraph block*',
          attrs: { checked: { default: null } },
        },
      },
      marks: {},
    });
    function p(text: string) {
      return milkdownLikeSchema.node('paragraph', null, milkdownLikeSchema.text(text));
    }
    function li(text: string) {
      return milkdownLikeSchema.node('list_item', null, p(text));
    }
    function ol(...items: ReturnType<typeof li>[]) {
      return milkdownLikeSchema.node('ordered_list', null, items);
    }
    function ul(...items: ReturnType<typeof li>[]) {
      return milkdownLikeSchema.node('bullet_list', null, items);
    }

    const myDoc = milkdownLikeSchema.node('doc', null, ol(li('One'), li('Two')));
    const state = EditorState.create({
      schema: milkdownLikeSchema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, 3),
    });
    const bulletList = milkdownLikeSchema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, bulletList, dispatch),
    );

    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(countNodes(newState, 'ordered_list')).toBe(0);
    expect(nodeTexts(newState, 'list_item')).toEqual(['One', 'Two']);
    // spread attr should be present with default value
    let hasSpread = false;
    newState.doc.descendants((node) => {
      if (node.type.name === 'bullet_list' && node.attrs.spread === false) {
        hasSpread = true;
      }
    });
    expect(hasSpread).toBe(true);
  });

  it('converts ordered to bullet with Milkdown-style list_item attrs', () => {
    // Milkdown's list_item has label, listType, and spread attrs. When
    // converting ordered→bullet, the list items from the ordered list
    // have listType: 'ordered' and label: '1.' — these must be reset to
    // defaults (listType: 'bullet', label: '•') or the editor continues
    // rendering them as ordered items despite being inside a <ul>.
    const fullSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
        bullet_list: {
          content: 'list_item+',
          group: 'block',
          attrs: { spread: { default: false } },
        },
        ordered_list: {
          content: 'list_item+',
          group: 'block',
          attrs: { order: { default: 1 }, spread: { default: false } },
        },
        list_item: {
          content: 'paragraph block*',
          group: 'listItem',
          attrs: {
            label: { default: '•' },
            listType: { default: 'bullet' },
            spread: { default: true },
          },
        },
      },
      marks: {},
    });
    function p(text: string) {
      return fullSchema.node('paragraph', null, fullSchema.text(text));
    }
    function li(text: string, attrs?: Record<string, unknown>) {
      return fullSchema.node('list_item', attrs ?? {}, p(text));
    }
    function ol(...items: ReturnType<typeof li>[]) {
      return fullSchema.node('ordered_list', null, items);
    }

    const myDoc = fullSchema.node(
      'doc',
      null,
      ol(
        li('One', { label: '1.', listType: 'ordered', spread: true }),
        li('Two', { label: '2.', listType: 'ordered', spread: true }),
      ),
    );
    const state = EditorState.create({
      schema: fullSchema,
      doc: myDoc,
      selection: TextSelection.create(myDoc, 3),
    });
    const bulletList = fullSchema.nodes.bullet_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, bulletList, dispatch),
    );

    expect(countNodes(newState, 'bullet_list')).toBe(1);
    expect(countNodes(newState, 'ordered_list')).toBe(0);
    // List items should have their attrs reset to defaults for bullet lists
    let allBulletType = true;
    newState.doc.descendants((node) => {
      if (node.type.name === 'list_item' && node.attrs.listType !== 'bullet') {
        allBulletType = false;
      }
    });
    expect(allBulletType).toBe(true);
  });

  it('clears checked attrs when switching task list to ordered list', () => {
    const myDoc = doc(ul(li('Task', 'task')));
    const state = stateWithDoc(myDoc, 3);
    const orderedList = schema.nodes.ordered_list;

    const newState = applyCommand(state, (st, dispatch) =>
      switchListType(st, orderedList, dispatch, {}),
    );

    expect(countNodes(newState, 'ordered_list')).toBe(1);
    // The list item should now have checked = null
    let hasTaskAttr = false;
    newState.doc.descendants((node) => {
      if (node.type.name === 'list_item' && node.attrs.checked !== null) {
        hasTaskAttr = true;
      }
    });
    expect(hasTaskAttr).toBe(false);
  });
});
