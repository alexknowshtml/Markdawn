import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/utils';
import { getPageIndexMap } from '../../hooks/useWorkspaceMeta';
import { wikiLink } from './wikilink';

const wikiLinkNodeView: NodeViewConstructor = (initialNode, view, getPos) => {
  const dom = document.createElement('a');
  dom.className = 'wiki-link';
  dom.href = '#';

  let node = initialNode;
  let unsub: (() => void) | null = null;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let renameTimeout: ReturnType<typeof setTimeout> | null = null;

  function setupObserver() {
    if (unsub) return;
    const map = getPageIndexMap();
    if (!map) {
      retryTimeout = setTimeout(setupObserver, 100);
      return;
    }
    const handler = () => updateDisplay();
    map.observe(handler);
    unsub = () => {
      try {
        map.unobserve(handler);
      } catch {
        /* already detached */
      }
    };
    updateDisplay();
  }

  function updateDisplay() {
    setupObserver();
    const currentTargetId = node.attrs.targetId as string;
    const currentHeading = node.attrs.heading as string;
    const storedLabel = node.attrs.label as string;

    const pageIndex = getPageIndexMap();
    let resolvedTitle = '';
    let resolvedTargetId = currentTargetId;

    if (pageIndex) {
      if (currentTargetId) {
        const pageData = pageIndex.get(currentTargetId) as { title?: string } | undefined;
        resolvedTitle = pageData?.title ?? '';
      }

      // Fallback: resolve by path/slug for manual wiki links without targetId.
      if (!resolvedTitle && node.attrs.path) {
        const path = String(node.attrs.path).toLowerCase();
        for (const [id, data] of pageIndex.entries()) {
          const pageData = data as { title?: string } | undefined;
          if (pageData?.title && pageData.title.toLowerCase() === path) {
            resolvedTitle = pageData.title;
            resolvedTargetId = String(id);
            break;
          }
        }
      }
    }

    const displayText = resolvedTitle || storedLabel || currentTargetId || 'wiki link';
    const pathDisplay = currentHeading ? `${displayText}#${currentHeading}` : displayText;

    dom.textContent = pathDisplay;
    dom.dataset.targetId = currentTargetId || resolvedTargetId;
    dom.dataset.path = pathDisplay;
    dom.dataset.heading = currentHeading;

    // When the target page is renamed, update the node attributes so the
    // Yjs document contains the new path. This ensures the collab server
    // extracts the correct slug on next persist, avoiding a stale-target
    // fallback lookup.
    const currentPath = node.attrs.path as string;
    if (resolvedTitle && currentPath !== resolvedTitle) {
      // Only auto-update label when it was a default label (matched the old path),
      // not when the user intentionally set a custom alias.
      const newLabel = storedLabel === currentPath ? resolvedTitle : storedLabel;
      const pos = getPos();
      if (typeof pos === 'number' && pos >= 0) {
        const attrs: Record<string, unknown> = {
          ...node.attrs,
          path: resolvedTitle,
          label: newLabel,
        };
        if (resolvedTargetId && !currentTargetId) {
          attrs.targetId = resolvedTargetId;
        }
        if (renameTimeout) clearTimeout(renameTimeout);
        // Delay to ensure the Milkdown collab plugin has finished binding
        // the Yjs document before we mutate ProseMirror state.
        renameTimeout = setTimeout(() => {
          const tr = view.state.tr.setNodeMarkup(pos, undefined, attrs);
          view.dispatch(tr);
        }, 500);
      }
    }
  }

  requestAnimationFrame(() => {
    setupObserver();
  });

  return {
    dom,
    update: (newNode) => {
      if (newNode.type.name !== 'wikiLink') return false;
      node = newNode;
      updateDisplay();
      return true;
    },
    destroy: () => {
      if (retryTimeout) clearTimeout(retryTimeout);
      if (renameTimeout) clearTimeout(renameTimeout);
      unsub?.();
    },
    ignoreMutation: () => true,
  };
};

export const wikiLinkView = $view(wikiLink, () => wikiLinkNodeView);
