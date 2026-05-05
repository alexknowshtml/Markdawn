import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useFolderTree } from './use-folders';

describe('useFolderTree', () => {
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
    renderHook(() => useFolderTree(''), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches folder tree successfully', async () => {
    const mockData = [
      {
        id: 'f1',
        workspaceId: 'ws-1',
        parentId: null,
        name: 'Folder',
        icon: null,
        position: 'a0',
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        children: [],
      },
    ];
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockData) });

    const { result } = renderHook(() => useFolderTree('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockData);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useFolderTree('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
