import { Schema } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  blockRange,
  collectListItems,
  findParentList,
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

function li(content: string, checked: 'task' | null = null) {
  const attrs = checked === 'task' ? { checked: false } : null;
  return schema.node('list_item', attrs, p(content));
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
//  collectListItems
// ============================================================
describe('collectListItems', () => {
  it('returns all list items within a range', () => {
    const myDoc = doc(ul(li('a'), li('b'), li('c')));
    const state = stateWithDoc(myDoc);
    const items = collectListItems(state.doc, 1, state.doc.content.size);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.node.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('returns items intersecting a partial range', () => {
    const myDoc = doc(ul(li('a'), li('b'), li('c')));
    const state = stateWithDoc(myDoc);
    // Find the "b" list item and its exact node size
    let bPos = -1;
    let bSize = -1;
    myDoc.descendants((node, pos) => {
      if (node.textContent === 'b' && node.type.name === 'list_item') {
        bPos = pos;
        bSize = node.nodeSize;
      }
    });
    expect(bPos).not.toBe(-1);
    // Range exactly matching the item's boundaries
    const items = collectListItems(state.doc, bPos, bPos + bSize);
    expect(items).toHaveLength(1);
    expect(items[0]?.node.textContent).toBe('b');
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
//  unwrapList  —  Regression tests for Bug 1
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
});

// ============================================================
//  switchListType  —  Regression tests for Bug 7
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
