import { $node } from '@milkdown/utils';

export const callout = $node('callout', () => ({
  group: 'block',
  content: 'block+',
  attrs: {
    type: { default: 'note' },
    title: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div.callout',
      getAttrs: (dom) => ({
        type: (dom as HTMLElement).getAttribute('data-callout-type') || 'note',
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: `callout callout-${node.attrs.type}`,
      'data-callout-type': node.attrs.type,
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === 'blockquote',
    runner: (state, node, nodeType) => {
      const firstChild = node.children?.[0];
      const firstText = firstChild?.children?.[0]?.value as string | undefined;
      if (!firstText) return;

      const regex = /\[!(\w+)\]\/?(.+)?/;
      const match = firstText.match(regex);
      if (!match?.[1]) return;

      const calloutType = match[1].toLowerCase();
      const validTypes = ['note', 'tip', 'warning', 'danger', 'info', 'example'];
      if (!validTypes.includes(calloutType)) return;

      const title = match[2]?.trim() ?? '';

      state.addNode(nodeType, { type: calloutType, title });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      const type = String(node.attrs.type).toUpperCase();
      const title = node.attrs.title ? ` ${node.attrs.title}` : '';
      state.addNode('text', undefined, `> [!${type}]${title}`);
    },
  },
}));
