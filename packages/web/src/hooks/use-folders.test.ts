import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useCreateFolder, useDeleteFolder, useFolderTree, useUpdateFolder } from './use-folders';

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

describe('useCreateFolder', () => {
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

  it('creates a folder successfully', async () => {
    const folder = { id: 'f-new', name: 'New Folder', workspaceId: 'ws-1' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(folder) });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', parentId: undefined, name: 'New Folder' }),
      }),
    );
  });

  it('creates folder with parent', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'f-new' }) });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1', parentId: 'f-parent' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body),
    ).toHaveProperty('parentId', 'f-parent');
  });

  it('handles creation error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Invalid workspace' }),
    });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Invalid workspace');
  });
});

describe('useDeleteFolder', () => {
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

  it('soft-deletes a folder', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useDeleteFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('force-deletes a folder with children', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useDeleteFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f1', force: true });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1?force=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useUpdateFolder', () => {
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

  it('renames a folder', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'f1', name: 'Renamed' }),
    });

    const { result } = renderHook(() => useUpdateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f1', updates: { name: 'Renamed' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    );
  });

  it('updates folder icon and position', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'f1' }) });

    const { result } = renderHook(() => useUpdateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      folderId: 'f1',
      updates: { icon: 'folder-open', position: 'b0', parentId: null },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body).toEqual({ icon: 'folder-open', position: 'b0', parentId: null });
  });
});
