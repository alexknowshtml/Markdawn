import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { usePageTree, useTrashPages } from './use-pages';

describe('usePageTree', () => {
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

  it('does not fetch when workspaceId is empty', () => {
    renderHook(() => usePageTree(''), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches page tree successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: 'p1', title: 'Page 1', children: [] }]),
    });

    const { result } = renderHook(() => usePageTree('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([{ id: 'p1', title: 'Page 1', children: [] }]);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => usePageTree('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useTrashPages', () => {
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

  it('does not fetch when workspaceId is empty', () => {
    renderHook(() => useTrashPages(''), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches trash pages successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: 'p1', title: 'Deleted', isDeleted: true }]),
    });

    const { result } = renderHook(() => useTrashPages('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([{ id: 'p1', title: 'Deleted', isDeleted: true }]);
  });
});
