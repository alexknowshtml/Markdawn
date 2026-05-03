import type { Ctx } from '@milkdown/kit/ctx';
import { nodeRule } from '@milkdown/kit/prose';
import { $inputRule, $node } from '@milkdown/utils';

const TAG_INPUT_REGEX = /(?:^|\s)#([A-Za-z0-9_-]+)\s$/;
const TAG_TEXT_REGEX = /(^|\s)#([A-Za-z0-9_-]+)(?=$|\s)/g;

export const tagNode = $node('tag', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    name: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span.tag',
      getAttrs: (dom) => ({
        name: (dom as HTMLElement).getAttribute('data-name') || '',
      }),
    },
  ],
  toDOM: (node) => ['span', { class: 'tag', 'data-name': node.attrs.name }, `#${node.attrs.name}`],
  parseMarkdown: {
    match: (node) =>
      node.type === 'text' && /(^|\s)#[A-Za-z0-9_-]+(?=$|\s)/.test(node.value as string),
    runner: (state, node, nodeType) => {
      const value = node.value as string;
      const regex = new RegExp(TAG_TEXT_REGEX.source, 'g');
      let lastIndex = 0;
      let match = regex.exec(value);

      while (match) {
        const start = match.index;
        const leading = match[1] ?? '';
        const name = match[2] ?? '';

        const textEnd = start + leading.length;
        if (textEnd > lastIndex) {
          state.addText(value.slice(lastIndex, textEnd));
        }

        if (name) {
          state.addNode(nodeType, { name });
        }

        lastIndex = textEnd + 1 + name.length;
        match = regex.exec(value);
      }

      if (lastIndex < value.length) {
        state.addText(value.slice(lastIndex));
      }
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'tag',
    runner: (state, node) => {
      state.addNode('text', undefined, `#${String(node.attrs.name)}`);
    },
  },
}));

export const tagInputRule = $inputRule((ctx: Ctx) =>
  nodeRule(TAG_INPUT_REGEX, tagNode.type(ctx), {
    getAttr: (match: RegExpMatchArray) => ({
      name: match[1] ?? '',
    }),
  }),
);

export const tag = [tagNode, tagInputRule];
