import type { Mark } from '@milkdown/kit/prose/model';
import { describe, expect, it } from 'vitest';
import { createSafeLinkView } from './safeLinkView';

const linkMark = (href: string, title: string | null = null) =>
  ({ attrs: { href, title } }) as unknown as Mark;

describe('createSafeLinkView', () => {
  it('renders allowed links with a safe href', () => {
    const view = createSafeLinkView(linkMark('example.com', 'Example'));
    const element = view.dom;

    expect(element).toBeInstanceOf(HTMLAnchorElement);
    if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element');
    expect(element.getAttribute('href')).toBe('https://example.com');
    expect(element.getAttribute('rel')).toBe('noopener noreferrer');
    expect(element.getAttribute('title')).toBe('Example');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:test',
  ])('never renders an href for %s', (href) => {
    const view = createSafeLinkView(linkMark(href));
    const element = view.dom;

    expect(element).toBeInstanceOf(HTMLSpanElement);
    if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element');
    expect(element.hasAttribute('href')).toBe(false);
    expect(element.getAttribute('data-unsafe-link')).toBe('true');
  });
});
