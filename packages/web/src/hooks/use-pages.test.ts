import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { showSuccessToast } from '../utils/toast';

import {
  useCreatePage,
  useDeletePage,
  useEmptyTrash,
  useImportMarkdown,
  useMovePage,
  usePageTree,
  usePages,
  usePermanentDeletePage,
  useRestorePage,
  useTrashPages,
  useUpdatePage,
} from './use-pages';

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

describe('usePages', () => {
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

  it('flattens nested page tree into flat list', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: 'p1',
            title: 'Parent',
            children: [
              { id: 'p2', title: 'Child 1', children: [] },
              {
                id: 'p3',
                title: 'Child 2',
                children: [{ id: 'p4', title: 'Grandchild', children: [] }],
              },
            ],
          },
        ]),
    });

    const { result } = renderHook(() => usePages('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(4);
    });

    const ids = result.current.data?.map((p) => p.id);
    expect(ids).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('returns empty array when no data', () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    const { result } = renderHook(() => usePages('ws-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.data).toEqual([]);
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

describe('useCreatePage', () => {
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

  it('creates a page successfully', async () => {
    const newPage = { id: 'p-new', title: 'My Page', workspaceId: 'ws-1' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(newPage) });

    const { result } = renderHook(() => useCreatePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1', title: 'My Page' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', parentId: undefined, title: 'My Page' }),
      }),
    );
  });

  it('suppresses success toast when silent option is set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'p-new', title: 'My Page' }),
    });

    const { result } = renderHook(() => useCreatePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1', silent: true });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it('handles creation error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Title required' }),
    });

    const { result } = renderHook(() => useCreatePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title required');
  });
});

describe('useUpdatePage', () => {
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

  it('updates page title', async () => {
    const updated = { id: 'p1', title: 'Updated Title' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(updated) });

    const { result } = renderHook(() => useUpdatePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p1', updates: { title: 'Updated Title' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated Title' }),
      }),
    );
  });

  it('suppresses success toast when silent option is set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'p1', title: 'Updated' }),
    });

    const { result } = renderHook(() => useUpdatePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p1', updates: { title: 'Updated' }, silent: true });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(showSuccessToast).not.toHaveBeenCalled();
  });
});

describe('useDeletePage', () => {
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

  it('soft-deletes a page', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ deleted: true }) });

    const { result } = renderHook(() => useDeletePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('p1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useRestorePage', () => {
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

  it('restores a trashed page', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'p1', title: 'Restored' }),
    });

    const { result } = renderHook(() => useRestorePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('p1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/restore',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

describe('usePermanentDeletePage', () => {
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

  it('permanently deletes a page', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => usePermanentDeletePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('p1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/permanent',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useEmptyTrash', () => {
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

  it('empties trash for workspace', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useEmptyTrash(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('ws-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/trash/empty-all?workspaceId=ws-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useMovePage', () => {
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

  it('moves page to new parent', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'p1', parentId: 'p2' }),
    });

    const { result } = renderHook(() => useMovePage(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageId: 'p1', parentId: 'p2', position: 'a0' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/move',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ parentId: 'p2', position: 'a0' }),
      }),
    );
  });
});

describe('useImportMarkdown', () => {
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

  it('imports markdown file', async () => {
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'p-new', title: 'test' }),
    });

    const { result } = renderHook(() => useImportMarkdown(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ workspaceId: 'ws-1', file });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const call = fetchMock.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(call[0]).toBe('/api/import/markdown?workspaceId=ws-1');
    expect(call[1]?.method).toBe('POST');
    expect(call[1]?.body instanceof FormData).toBe(true);
  });
});
