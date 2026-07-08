import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import {
  useBulkDeleteFolders,
  useBulkDeletePages,
  useBulkMoveFolders,
  useBulkMovePages,
} from './use-bulk-actions';

describe('useBulkDeletePages', () => {
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

  it('deletes multiple pages', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkDeletePages(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageIds: ['p1', 'p2', 'p3'] });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p2',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p3',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('handles partial failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Forbidden' }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useBulkDeletePages(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageIds: ['p1', 'p2', 'p3'] });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useBulkDeleteFolders', () => {
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

  it('deletes multiple folders', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkDeleteFolders(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderIds: ['f1', 'f2'] });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1?force=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f2?force=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useBulkMovePages', () => {
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

  it('moves multiple pages to new parent', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkMovePages(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageIds: ['p1', 'p2'], parentId: 'f1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/move',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ parentId: 'f1' }),
      }),
    );
  });

  it('moves pages to root (null parent)', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkMovePages(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageIds: ['p1'], parentId: null });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.parentId).toBeNull();
  });
});

describe('useBulkMoveFolders', () => {
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

  it('moves multiple folders', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkMoveFolders(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ folderIds: ['f1', 'f2'], parentId: 'f-parent' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folders/f1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ parentId: 'f-parent' }),
      }),
    );
  });
});
