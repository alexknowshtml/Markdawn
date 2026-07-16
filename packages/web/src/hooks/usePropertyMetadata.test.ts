import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPageTreeNode } from '../test-utils/factories';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';
import { usePropertyMetadata } from './usePropertyMetadata';

vi.mock('./use-tags', () => ({
  useTags: vi.fn(),
}));

import { useTags } from './use-tags';

const mockUseTags = vi.mocked(useTags);

describe('usePropertyMetadata', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let refetchTags: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    refetchTags = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockUseTags.mockReturnValue({
      data: [],
      refetch: refetchTags,
    } as unknown as ReturnType<typeof useTags>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('combines property and indexed content tags from accessible pages', async () => {
    mockUseTags.mockReturnValue({
      data: [
        { id: '#body-tag', name: 'body-tag', page_count: 1 },
        { id: '#tech', name: 'tech', page_count: 1 },
      ],
      refetch: refetchTags,
    } as unknown as ReturnType<typeof useTags>);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          createMockPageTreeNode({ properties: { tags: ['Tech', '#tech', ' alertship '] } }),
          createMockPageTreeNode({ properties: { custom: 'value', tag: 'child' } }),
        ]),
    });

    const { result } = renderHook(() => usePropertyMetadata(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.allTags).toEqual(['alertship', 'body-tag', 'child', 'Tech']);
    });
    expect(result.current.allKeys).toEqual(
      expect.arrayContaining(['author', 'created', 'custom', 'date', 'tags', 'updated', 'url']),
    );
  });

  it('updates suggestions when the page tree cache changes', async () => {
    const page = createMockPageTreeNode({ properties: null });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([page]),
    });

    const { result } = renderHook(() => usePropertyMetadata(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(result.current.allTags).toEqual([]);

    act(() => {
      queryClient.setQueryData(
        ['pageTree'],
        [{ ...page, properties: { tags: ['without-refresh'] } }],
      );
    });

    await waitFor(() => {
      expect(result.current.allTags).toEqual(['without-refresh']);
    });
  });

  it('refreshes indexed tags on demand', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { result } = renderHook(() => usePropertyMetadata(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => result.current.refreshTags());

    expect(refetchTags).toHaveBeenCalledOnce();
  });

  it('ignores invalid and empty tag values', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          createMockPageTreeNode({
            properties: { tags: ['valid', '', '  ', null, 42] },
          }),
        ]),
    });

    const { result } = renderHook(() => usePropertyMetadata(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.allTags).toEqual(['valid']);
    });
  });
});
