import { describe, expect, it } from 'vitest';
import { wikiLinkNodeView } from './wikiLinkView';

type WikiLinkNode = {
  attrs: { path: string; heading: string; label: string };
  type: { name: string };
};

function createNode(path: string, label = path, heading = ''): WikiLinkNode {
  return {
    attrs: { path, heading, label },
    type: { name: 'wikiLink' },
  };
}

function renderNode(node: WikiLinkNode) {
  return wikiLinkNodeView(node as never, {} as never, (() => 0) as never, [] as never, [] as never);
}

describe('wikiLinkNodeView target confidentiality', () => {
  it('renders an accessible authored path without guessing or serializing a target ID', () => {
    const view = renderNode(createNode('Roadmap'));
    const anchor = view.dom as HTMLAnchorElement;

    expect(anchor.textContent).toBe('Roadmap');
    expect(anchor.dataset.path).toBe('Roadmap');
    expect(anchor.hasAttribute('data-target-id')).toBe(false);
    expect(anchor.getAttribute('href')).toBe('#');
  });

  it('does not expose a hidden target UUID in unresolved DOM', () => {
    const hiddenTargetId = '22222222-2222-2222-2222-222222222222';
    const view = renderNode(createNode('Private roadmap', 'Authored alias'));
    const anchor = view.dom as HTMLAnchorElement;

    expect(anchor.textContent).toBe('Authored alias');
    expect(anchor.hasAttribute('data-target-id')).toBe(false);
    expect(anchor.outerHTML).not.toContain(hiddenTargetId);
    expect(anchor.getAttribute('href')).toBe('#');
  });

  it('updates only authored display attributes supplied by the shared node', () => {
    const view = renderNode(createNode('Roadmap'));

    expect(
      view.update?.(
        createNode('Plans/Roadmap', 'Plan', 'Milestone') as never,
        [] as never,
        [] as never,
      ),
    ).toBe(true);

    const anchor = view.dom as HTMLAnchorElement;
    expect(anchor.textContent).toBe('Plan#Milestone');
    expect(anchor.dataset.path).toBe('Plans/Roadmap');
    expect(anchor.dataset.heading).toBe('Milestone');
    expect(anchor.getAttribute('href')).toBe('#');
  });
});
