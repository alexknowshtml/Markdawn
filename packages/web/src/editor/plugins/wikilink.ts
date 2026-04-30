import { $node } from '@milkdown/utils';

export const wikiLink = $node('wikiLink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    path: { default: '' },
    heading: { default: '' },
    label: { default: '' }
  },
  parseDOM: [{
    tag: 'a.wiki-link',
    getAttrs: (dom) => ({
      path: (dom as HTMLElement).getAttribute('data-path'),
      heading: (dom as HTMLElement).getAttribute('data-heading') || '',
      label: dom.textContent
    })
  }],
  toDOM: (node) => ['a', {
    class: 'wiki-link',
    href: '#',
    'data-path': node.attrs.path,
    'data-heading': node.attrs.heading || ''
  }, node.attrs.label],
  parseMarkdown: {
    match: (node) =>
      node.type === 'text' &&
      /^\[\[(?:[^\]|#]+)?(?:#[^\]|]+)?(?:\|.+?)?\]\]$/.test(node.value as string),
    runner: (state, node, nodeType) => {
      const match = (node.value as string).match(/^\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|(.+?))?\]\]$/);
      if (match) {
        const path = match[1] || '';
        const heading = match[2] || '';
        const label = match[3] || (path ? (heading ? `${path}#${heading}` : path) : `#${heading}`);

        state.addNode(nodeType, {
          path,
          heading,
          label
        });
      }
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikiLink',
    runner: (state, node) => {
      const path = String(node.attrs.path || '');
      const heading = String(node.attrs.heading || '');
      const target = heading ? `${path}#${heading}` : path;
      const defaultLabel = path ? (heading ? `${path}#${heading}` : path) : `#${heading}`;
      const text = node.attrs.label !== defaultLabel
        ? `[[${target}|${node.attrs.label}]]`
        : `[[${target}]]`;
      state.addNode('text', undefined, text);
    }
  }
}));
