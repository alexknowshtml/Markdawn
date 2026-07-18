import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import {
  useCreateFolder,
  useDeleteFolder,
  useEmptyFolderTrash,
  useFolderTree,
  usePermanentDeleteFolder,
  useRestoreFolder,
  useTrashFolders,
  useUpdateFolder,
} from './use-folders';

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

  it('fetches folder tree successfully', async () => {
    const mockData = [
      {
        id: 'f1',
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

    const { result } = renderHook(() => useFolderTree(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockData);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useFolderTree(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('folder Trash hooks', () => {
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

  it('fetches deleted folders', async () => {
    const folders = [{ id: 'f1', name: 'Deleted folder', isDeleted: true }];
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(folders) });

    const { result } = renderHook(() => useTrashFolders(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith('/api/folders/trash');
    expect(result.current.data).toEqual(folders);
  });

  it('restores a deleted folder subtree', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ id: 'f1', name: 'Restored', restoredFolders: 2, restoredPages: 1 }),
    });

    const { result } = renderHook(() => useRestoreFolder(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('f1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1/restore',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('permanently deletes a trashed folder subtree', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true, folders: 2, pages: 1 }),
    });

    const { result } = renderHook(() => usePermanentDeleteFolder(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate('f1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1/permanent',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('empties all trashed folder subtrees', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true, folders: 2, pages: 1 }),
    });

    const { result } = renderHook(() => useEmptyFolderTrash(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/trash/empty-all',
      expect.objectContaining({ method: 'DELETE' }),
    );
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
    const folder = { id: 'f-new', name: 'New Folder' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(folder) });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({});

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ parentId: undefined, name: 'New Folder' }),
      }),
    );
  });

  it('invalidates shared navigation after creating a folder', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'f-new' }) });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ parentId: 'shared-parent' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shared-with-me'] });
  });

  it('creates folder with parent', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'f-new' }) });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ parentId: 'f-parent' });

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
      json: () => Promise.resolve({ message: 'Invalid request' }),
    });

    const { result } = renderHook(() => useCreateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({});

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Invalid request');
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

  it('invalidates shared navigation after updating a folder', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'f1' }) });

    const { result } = renderHook(() => useUpdateFolder(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderId: 'f1', updates: { name: 'Renamed' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shared-with-me'] });
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
