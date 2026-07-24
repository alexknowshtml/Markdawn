import type { WikiLinkPresentation } from '@markdawn/shared';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshWikiLinkPresentations,
  registerWikiLinkPresentationResolver,
} from '../wikiLinkPresentations';
import { wikiLinkNodeView } from './wikiLinkView';

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_TARGET_ID = '22222222-2222-4222-8222-222222222222';

function createNode(attributes: Record<string, string>): ProseNode {
  return {
    attrs: { targetId: '', path: '', heading: '', label: '', ...attributes },
    type: { name: 'wikiLink' },
  } as unknown as ProseNode;
}

function createNodeView(
  node: ProseNode,
  view: EditorView,
  getPos?: () => number | undefined,
): NodeView {
  return (
    wikiLinkNodeView as unknown as (
      node: ProseNode,
      view: EditorView,
      getPos?: () => number | undefined,
    ) => NodeView
  )(node, view, getPos);
}

describe('wikiLinkNodeView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the current server title and updates automatically after a rename', async () => {
    const view = {} as EditorView;
    let currentTitle = 'Roadmap';
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: currentTitle },
      },
    ]);
    const nodeView = createNodeView(createNode({ targetId: TARGET_ID }), view);
    const link = nodeView.dom as HTMLAnchorElement;

    await waitFor(() => expect(link).toHaveTextContent('Roadmap'));
    expect(link.dataset.targetId).toBe(TARGET_ID);
    expect(link.dataset.targetTitle).toBe('Roadmap');

    currentTitle = '2026 Roadmap';
    refreshWikiLinkPresentations(view);
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('data-target-id');

    await waitFor(() => expect(link).toHaveTextContent('2026 Roadmap'));
    expect(link.dataset.targetTitle).toBe('2026 Roadmap');
    nodeView.destroy?.();
    unregister();
  });

  it('preserves a custom alias for an accessible target', async () => {
    const view = {} as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: '2026 Roadmap' },
      },
    ]);
    const nodeView = createNodeView(
      createNode({ targetId: TARGET_ID, label: 'Project plan' }),
      view,
    );
    const link = nodeView.dom as HTMLAnchorElement;

    await waitFor(() => expect(link).toHaveTextContent('Project plan'));
    expect(link).not.toHaveTextContent('2026 Roadmap');
    nodeView.destroy?.();
    unregister();
  });

  it('binds a uniquely resolved authored path without retaining its default title', async () => {
    const node = createNode({ path: 'Roadmap' });
    const setNodeMarkup = vi.fn().mockReturnValue({});
    const dispatch = vi.fn();
    const view = {
      editable: true,
      state: {
        doc: { nodeAt: () => node },
        tr: { setNodeMarkup },
      },
      dispatch,
    } as unknown as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: 'Roadmap' },
      },
    ]);
    const nodeView = createNodeView(node, view, () => 7);

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(setNodeMarkup).toHaveBeenCalledWith(
      7,
      undefined,
      expect.objectContaining({ targetId: TARGET_ID, path: '', label: '' }),
    );
    nodeView.destroy?.();
    unregister();
  });

  it('preserves an explicit alias that equals the authored path', async () => {
    const node = createNode({ path: 'Roadmap', label: 'Roadmap' });
    const setNodeMarkup = vi.fn().mockReturnValue({});
    const dispatch = vi.fn();
    const view = {
      editable: true,
      state: {
        doc: { nodeAt: () => node },
        tr: { setNodeMarkup },
      },
      dispatch,
    } as unknown as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: 'Roadmap' },
      },
    ]);
    const nodeView = createNodeView(node, view, () => 4);

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(setNodeMarkup).toHaveBeenCalledWith(
      4,
      undefined,
      expect.objectContaining({ targetId: TARGET_ID, path: '', label: 'Roadmap' }),
    );
    nodeView.destroy?.();
    unregister();
  });

  it('preserves a heading embedded in an imported authored path', async () => {
    const node = createNode({ path: '/Roadmap.md#Milestones' });
    const setNodeMarkup = vi.fn().mockReturnValue({});
    const dispatch = vi.fn();
    const view = {
      editable: true,
      state: {
        doc: { nodeAt: () => node },
        tr: { setNodeMarkup },
      },
      dispatch,
    } as unknown as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: 'Roadmap' },
      },
    ]);
    const nodeView = createNodeView(node, view, () => 6);

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(setNodeMarkup).toHaveBeenCalledWith(
      6,
      undefined,
      expect.objectContaining({
        targetId: TARGET_ID,
        path: '',
        heading: 'Milestones',
        label: '',
      }),
    );
    nodeView.destroy?.();
    unregister();
  });

  it('renders an embedded imported heading for a read-only viewer', async () => {
    const view = { editable: false } as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: 'Roadmap' },
      },
    ]);
    const nodeView = createNodeView(createNode({ path: 'Roadmap#Milestones' }), view);
    const link = nodeView.dom as HTMLAnchorElement;

    await waitFor(() => expect(link).toHaveTextContent('Roadmap#Milestones'));
    expect(link.dataset.heading).toBe('Milestones');
    nodeView.destroy?.();
    unregister();
  });

  it('refreshes a resolved path when a targeted invalidation names its target', async () => {
    const view = { editable: false } as EditorView;
    let currentTitle = 'Roadmap';
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: currentTitle },
      },
    ]);
    const nodeView = createNodeView(createNode({ path: 'Roadmap' }), view);
    const link = nodeView.dom as HTMLAnchorElement;
    await waitFor(() => expect(link).toHaveTextContent('Roadmap'));

    currentTitle = 'Renamed roadmap';
    refreshWikiLinkPresentations(view, [TARGET_ID]);

    await waitFor(() => expect(link).toHaveTextContent('Renamed roadmap'));
    nodeView.destroy?.();
    unregister();
  });

  it('does not refetch unrelated links when a targeted invalidation races a batch', async () => {
    const view = { editable: false } as EditorView;
    const requests: Array<Array<{ key: string; targetId?: string; path?: string }>> = [];
    const resolveRequests: Array<(presentations: WikiLinkPresentation[]) => void> = [];
    const unregister = registerWikiLinkPresentationResolver(view, (batch) => {
      requests.push(batch);
      return new Promise<WikiLinkPresentation[]>((resolve) => resolveRequests.push(resolve));
    });
    const firstView = createNodeView(createNode({ targetId: TARGET_ID }), view);
    const secondView = createNodeView(createNode({ targetId: SECOND_TARGET_ID }), view);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toHaveLength(2);
    refreshWikiLinkPresentations(view, [TARGET_ID]);
    resolveRequests[0]?.(
      (requests[0] ?? []).map((request) => ({
        key: request.key,
        state: 'accessible',
        target: {
          id: request.targetId ?? '',
          title: request.targetId === TARGET_ID ? 'Stale title' : 'Second target',
        },
      })),
    );

    await waitFor(() => expect(secondView.dom).toHaveTextContent('Second target'));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual([expect.objectContaining({ targetId: TARGET_ID })]);
    resolveRequests[1]?.([
      {
        key: requests[1]?.[0]?.key ?? '',
        state: 'accessible',
        target: { id: TARGET_ID, title: 'Fresh title' },
      },
    ]);
    await waitFor(() => expect(firstView.dom).toHaveTextContent('Fresh title'));

    firstView.destroy?.();
    secondView.destroy?.();
    unregister();
  });

  it('binds a heading-only link to the source resolved by the server', async () => {
    const node = createNode({ heading: 'Overview' });
    const setNodeMarkup = vi.fn().mockReturnValue({});
    const dispatch = vi.fn();
    const view = {
      editable: true,
      state: {
        doc: { nodeAt: () => node },
        tr: { setNodeMarkup },
      },
      dispatch,
    } as unknown as EditorView;
    const resolver = vi.fn(async ([request]) => [
      {
        key: request?.key ?? '',
        state: 'accessible' as const,
        target: { id: TARGET_ID, title: 'Source page' },
      },
    ]);
    const unregister = registerWikiLinkPresentationResolver(view, resolver);
    const nodeView = createNodeView(node, view, () => 3);

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(resolver).toHaveBeenCalledWith([expect.objectContaining({ path: '#Overview' })]);
    expect(setNodeMarkup).toHaveBeenCalledWith(
      3,
      undefined,
      expect.objectContaining({ targetId: TARGET_ID, path: '', label: '' }),
    );
    nodeView.destroy?.();
    unregister();
  });

  it('renders a private target as a disabled restricted link without leaking metadata', async () => {
    const view = {} as EditorView;
    const unregister = registerWikiLinkPresentationResolver(view, async ([request]) => [
      { key: request?.key ?? '', state: 'restricted' },
    ]);
    const nodeView = createNodeView(
      createNode({ targetId: TARGET_ID, label: 'Private alias' }),
      view,
    );
    const link = nodeView.dom as HTMLAnchorElement;

    await waitFor(() => expect(link).toHaveTextContent('Restricted page'));
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).toHaveAttribute('title', "You don't have access to this page.");
    expect(link).not.toHaveAttribute('href');
    expect(link).not.toHaveAttribute('data-target-id');
    expect(link).not.toHaveAttribute('data-target-title');
    expect(link).not.toHaveAttribute('data-path');
    nodeView.destroy?.();
    unregister();
  });

  it('keeps resolver failures distinct and automatically retries transient failures', async () => {
    const view = {} as EditorView;
    let offline = true;
    const resolver = vi.fn(async (requests: Array<{ key: string }>) => {
      if (offline) throw new Error('offline');
      return requests.map((request) => ({
        key: request.key,
        state: 'accessible' as const,
        target: { id: TARGET_ID, title: 'Roadmap' },
      }));
    });
    const unregister = registerWikiLinkPresentationResolver(view, resolver);
    const firstNodeView = createNodeView(createNode({ targetId: TARGET_ID }), view);
    const secondNodeView = createNodeView(createNode({ targetId: SECOND_TARGET_ID }), view);
    const firstLink = firstNodeView.dom as HTMLAnchorElement;
    const secondLink = secondNodeView.dom as HTMLAnchorElement;

    await waitFor(() => expect(firstLink).toHaveTextContent('Couldn’t check link'));
    expect(secondLink).toHaveTextContent('Couldn’t check link');
    expect(firstLink).toHaveAttribute('data-state', 'error');
    expect(firstLink).toHaveAttribute('aria-disabled', 'true');
    expect(firstLink).not.toHaveAttribute('href');
    expect(firstLink).not.toHaveAttribute('data-target-id');

    offline = false;
    await waitFor(() => expect(firstLink).toHaveTextContent('Roadmap'));
    expect(secondLink).toHaveTextContent('Roadmap');
    expect(firstLink).toHaveAttribute('data-state', 'accessible');
    expect(resolver.mock.calls.every(([requests]) => requests.length === 2)).toBe(true);
    firstNodeView.destroy?.();
    secondNodeView.destroy?.();
    unregister();
  });
});
