import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/utils';
import { wikiLink } from './wikilink';

/**
 * Wiki-link identity resolution is deliberately absent from the shared editor
 * node. The click-time API resolves the authored path from the trusted
 * connection index for the current requester; rendering never guesses an ID.
 */
export const wikiLinkNodeView: NodeViewConstructor = (initialNode) => {
  const dom = document.createElement('a');
  dom.className = 'wiki-link';
  dom.href = '#';

  let node = initialNode;
  const updateDisplay = () => {
    const heading = String(node.attrs.heading || '');
    const label = String(node.attrs.label || '');
    const path = String(node.attrs.path || '');
    const displayText = label || path || 'wiki link';

    dom.textContent = heading ? `${displayText}#${heading}` : displayText;
    dom.dataset.path = path;
    dom.dataset.heading = heading;
    dom.href = '#';
  };
  updateDisplay();

  return {
    dom,
    update: (newNode) => {
      if (newNode.type.name !== 'wikiLink') return false;
      node = newNode;
      updateDisplay();
      return true;
    },
    ignoreMutation: () => true,
  };
};

export const wikiLinkView = $view(wikiLink, () => wikiLinkNodeView);
