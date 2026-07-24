import type { Mark } from '@milkdown/kit/prose/model';
import type { MarkView } from '@milkdown/kit/prose/view';
import { ensureAbsoluteUrl } from '../../utils/url';

/**
 * Prevents untrusted collaborative link marks from placing executable URLs in
 * the DOM. Input validation alone is insufficient because a custom Yjs client
 * can bypass the editor controls and write mark attributes directly.
 */
export function createSafeLinkView(mark: Mark): MarkView {
  const rawHref = typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
  const safeHref = ensureAbsoluteUrl(rawHref);
  const element = document.createElement(safeHref ? 'a' : 'span');

  if (safeHref && element instanceof HTMLAnchorElement) {
    element.href = safeHref;
    element.rel = 'noopener noreferrer';
  } else {
    element.className = 'unsafe-editor-link';
    element.dataset.unsafeLink = 'true';
  }

  if (typeof mark.attrs.title === 'string' && mark.attrs.title) {
    element.title = mark.attrs.title;
  }

  return { dom: element, contentDOM: element };
}
