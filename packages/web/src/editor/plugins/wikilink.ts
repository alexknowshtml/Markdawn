import { $node } from '@milkdown/utils';

export const wikiLink = $node('wikiLink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    targetId: { default: '' },
    path: { default: '' },
    heading: { default: '' },
    label: { default: '' },
  },
  parseDOM: [
    {
      tag: 'a.wiki-link',
      getAttrs: (dom) => ({
        targetId: (dom as HTMLElement).getAttribute('data-target-id') || '',
        path: (dom as HTMLElement).getAttribute('data-path'),
        heading: (dom as HTMLElement).getAttribute('data-heading') || '',
        label: (dom as HTMLElement).getAttribute('data-label') || '',
      }),
    },
  ],
  toDOM: (node) => [
    'a',
    {
      class: 'wiki-link',
      href: '#',
      'data-target-id': node.attrs.targetId || '',
      'data-path': node.attrs.path,
      'data-heading': node.attrs.heading || '',
      'data-label': node.attrs.label || '',
    },
    node.attrs.label || node.attrs.path || 'Wiki link',
  ],
  parseMarkdown: {
    match: (node) =>
      node.type === 'text' &&
      /^\[\[(?:[^\]|#]+)?(?:#[^\]|]+)?(?:\|.+?)?\]\]$/.test(node.value as string),
    runner: (state, node, nodeType) => {
      const match = (node.value as string).match(/^\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|(.+?))?\]\]$/);
      if (match) {
        const path = match[1] || '';
        const heading = match[2] || '';
        const label = match[3] || '';

        state.addNode(nodeType, {
          path,
          heading,
          label,
        });
      }
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikiLink',
    runner: (state, node) => {
      const path = String(node.attrs.path || '');
      const targetId = String(node.attrs.targetId || '');
      if (targetId && !path) {
        state.addNode('text', undefined, String(node.attrs.label || 'Link unavailable'));
        return;
      }
      const heading = String(node.attrs.heading || '');
      const target = heading ? `${path}#${heading}` : path;
      const label = String(node.attrs.label || '');
      const text = label ? `[[${target}|${label}]]` : `[[${target}]]`;
      state.addNode('text', undefined, text);
    },
  },
}));
