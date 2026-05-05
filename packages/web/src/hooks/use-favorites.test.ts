import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useFavorites } from './use-favorites';

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

  it('does not fetch when workspaceId is undefined', () => {
    renderHook(() => useFavorites(undefined), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches favorites successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          favorites: [{ pageId: 'p1', title: 'Page 1', icon: null, createdAt: null }],
        }),
    });

    const { result } = renderHook(() => useFavorites('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([
      { pageId: 'p1', title: 'Page 1', icon: null, createdAt: null },
    ]);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useFavorites('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
