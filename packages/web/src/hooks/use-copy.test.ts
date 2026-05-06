import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useCopyFolder, useCopyPage } from './use-copy';

describe('useCopyPage', () => {
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

  it('copies a page successfully', async () => {
    const copied = { id: 'p-copy', title: 'Copy of Original', workspaceId: 'ws-1' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(copied) });

    const { result } = renderHook(() => useCopyPage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p1', workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/copy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ parentId: undefined }),
      }),
    );
  });

  it('copies page under parent', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'p-copy' }) });

    const { result } = renderHook(() => useCopyPage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p1', parentId: 'p-parent', workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.parentId).toBe('p-parent');
  });

  it('handles copy error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Page not found' }),
    });

    const { result } = renderHook(() => useCopyPage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p-missing', workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Page not found');
  });
});

describe('useCopyFolder', () => {
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

  it('copies a folder successfully', async () => {
    const copied = { id: 'f-copy', name: 'Copy of Folder', workspaceId: 'ws-1' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(copied) });

    const { result } = renderHook(() => useCopyFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f1', workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1/copy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ parentId: undefined }),
      }),
    );
  });

  it('handles copy error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Folder not found' }),
    });

    const { result } = renderHook(() => useCopyFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f-missing', workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Folder not found');
  });
});
