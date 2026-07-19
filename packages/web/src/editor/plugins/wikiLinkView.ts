import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/utils';
import {
  type ResolvedWikiLinkPresentation,
  subscribeToWikiLinkPresentation,
} from '../wikiLinkPresentations';
import { wikiLink } from './wikilink';

function getWikiLinkHeading(node: ProseNode): string {
  const explicitHeading = String(node.attrs.heading || '');
  if (explicitHeading) return explicitHeading;
  const path = String(node.attrs.path || '');
  const hashIndex = path.indexOf('#');
  return hashIndex >= 0 ? path.slice(hashIndex + 1) : '';
}

/**
 * The server decides whether the current viewer may see and open a target.
 * The node view only renders that presentation; it never guesses by title.
 */
export const wikiLinkNodeView: NodeViewConstructor = (initialNode, view, getPos) => {
  const dom = document.createElement('a');
  dom.className = 'wiki-link';
  dom.href = '#';

  let node = initialNode;
  let unsubscribe: (() => void) | null = null;
  let presentation: ResolvedWikiLinkPresentation = { state: 'loading' };

  const bindResolvedPath = (target: { id: string }): void => {
    const targetId = String(node.attrs.targetId || '');
    const path = String(node.attrs.path || '');
    const nodeHeading = getWikiLinkHeading(node);
    if (targetId || (!path && !nodeHeading) || !view.editable || typeof getPos !== 'function') {
      return;
    }

    const position = getPos();
    if (typeof position !== 'number') return;
    const currentNode = view.state.doc.nodeAt(position);
    if (!currentNode || currentNode.type.name !== 'wikiLink') return;
    if (
      String(currentNode.attrs.targetId || '') ||
      String(currentNode.attrs.path || '') !== path ||
      getWikiLinkHeading(currentNode) !== nodeHeading
    ) {
      return;
    }

    const heading = getWikiLinkHeading(currentNode);
    const label = String(currentNode.attrs.label || '');
    view.dispatch(
      view.state.tr.setNodeMarkup(position, undefined, {
        ...currentNode.attrs,
        targetId: target.id,
        path: '',
        heading,
        label,
      }),
    );
  };

  const updateDisplay = () => {
    const heading = getWikiLinkHeading(node);
    const label = String(node.attrs.label || '');

    dom.className = 'wiki-link';
    dom.removeAttribute('data-target-id');
    dom.removeAttribute('data-target-title');
    dom.removeAttribute('data-path');
    dom.dataset.heading = heading;
    dom.removeAttribute('href');

    if (presentation.state === 'accessible') {
      const displayText = label || presentation.target.title;
      dom.textContent = !label && heading ? `${displayText}#${heading}` : displayText;
      dom.dataset.state = 'accessible';
      dom.dataset.targetId = presentation.target.id;
      dom.dataset.targetTitle = presentation.target.title;
      dom.href = '#';
      dom.removeAttribute('aria-disabled');
      dom.removeAttribute('tabindex');
      dom.removeAttribute('title');
      return;
    }

    dom.setAttribute('aria-disabled', 'true');
    dom.tabIndex = -1;
    if (presentation.state === 'restricted') {
      dom.textContent = 'Restricted page';
      dom.dataset.state = 'restricted';
      dom.title = "You don't have access to this page.";
      dom.classList.add('wiki-link-restricted');
      return;
    }

    dom.textContent = presentation.state === 'loading' ? 'Loading link…' : 'Link unavailable';
    dom.dataset.state = presentation.state;
    dom.title = presentation.state === 'loading' ? 'Resolving link' : 'This link is unavailable.';
    dom.classList.add('wiki-link-unavailable');
  };

  const subscribe = () => {
    unsubscribe?.();
    const targetId = String(node.attrs.targetId || '');
    const path = String(node.attrs.path || '');
    const heading = getWikiLinkHeading(node);
    const resolutionPath = path || (!targetId && heading ? `#${heading}` : '');
    presentation = { state: 'loading' };
    updateDisplay();
    if (!targetId && !resolutionPath) {
      presentation = { state: 'unavailable' };
      updateDisplay();
      return;
    }
    unsubscribe = subscribeToWikiLinkPresentation(
      view,
      {
        ...(targetId && { targetId }),
        ...(resolutionPath && { path: resolutionPath }),
      },
      (nextPresentation) => {
        if (nextPresentation.state === 'accessible') {
          bindResolvedPath(nextPresentation.target);
        }
        presentation = nextPresentation;
        updateDisplay();
      },
    );
  };
  subscribe();

  return {
    dom,
    update: (newNode) => {
      if (newNode.type.name !== 'wikiLink') return false;
      const targetChanged =
        newNode.attrs.targetId !== node.attrs.targetId ||
        newNode.attrs.path !== node.attrs.path ||
        newNode.attrs.heading !== node.attrs.heading;
      node = newNode;
      if (targetChanged) subscribe();
      else updateDisplay();
      return true;
    },
    destroy: () => unsubscribe?.(),
    ignoreMutation: () => true,
  };
};

export const wikiLinkView = $view(wikiLink, () => wikiLinkNodeView);
