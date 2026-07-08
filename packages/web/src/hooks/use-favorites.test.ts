import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useFavorites, useToggleFavorite } from './use-favorites';

describe('useFavorites', () => {
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

  it('fetches favorites successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          favorites: [{ pageId: 'p1', title: 'Page 1', icon: null, createdAt: null }],
        }),
    });

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([
      {
        entityType: 'page',
        entityId: 'p1',
        pageId: 'p1',
        title: 'Page 1',
        icon: null,
        createdAt: null,
      },
    ]);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('adds a favorite when the item is not already favorited', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useToggleFavorite(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        entityType: 'folder',
        entityId: 'f1',
        title: 'Folder 1',
        icon: null,
        isFavorite: false,
      });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'folder', entityId: 'f1' }),
    });
  });

  it('removes a favorite when the item is already favorited', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useToggleFavorite(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        entityType: 'folder',
        entityId: 'f1',
        isFavorite: true,
      });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/favorites/folder/f1', {
      method: 'DELETE',
    });
  });
});
