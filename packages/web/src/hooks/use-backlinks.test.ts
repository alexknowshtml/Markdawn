import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

import { useBacklinks, useOutgoingLinks } from './use-backlinks';

describe('useBacklinks', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('does not fetch when pageId is undefined', () => {
    renderHook(() => useBacklinks(undefined), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches backlinks successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: 'bl-1',
            sourcePageId: 'p2',
            linkText: 'Test',
            linkType: 'wiki',
            createdAt: '2024-01-01',
            sourceTitle: 'Source',
            sourceIcon: null,
          },
        ]),
    });

    const { result } = renderHook(() => useBacklinks('p1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([
      {
        id: 'bl-1',
        sourcePageId: 'p2',
        linkText: 'Test',
        linkType: 'wiki',
        createdAt: '2024-01-01',
        sourceTitle: 'Source',
        sourceIcon: null,
      },
    ]);
  });
});

describe('useOutgoingLinks', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('does not fetch when pageId is undefined', () => {
    renderHook(() => useOutgoingLinks(undefined), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches outgoing links successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: 'ol-1',
            targetPageId: 'p2',
            targetTitle: 'Target',
            linkText: 'Target Page',
            linkType: 'wiki',
            targetPageTitle: 'Target Page',
            targetPageIcon: null,
          },
        ]),
    });

    const { result } = renderHook(() => useOutgoingLinks('p1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([
      {
        id: 'ol-1',
        targetPageId: 'p2',
        targetTitle: 'Target',
        linkText: 'Target Page',
        linkType: 'wiki',
        targetPageTitle: 'Target Page',
        targetPageIcon: null,
      },
    ]);
  });
});
