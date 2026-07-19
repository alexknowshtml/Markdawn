import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdentityLifecycle,
  IdentityLifecycleProvider,
} from '../contexts/IdentityLifecycleContext';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';
import { isBulkRemovalInProgress } from '../utils/bulkRemovalState';

const toastMocks = vi.hoisted(() => ({
  showSuccessToast: vi.fn(),
}));

vi.mock('../utils/toast', () => ({
  showSuccessToast: toastMocks.showSuccessToast,
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import {
  BulkRemovalError,
  buildBulkRemovalInput,
  getBulkRemovalCounts,
  useBulkDeleteFolders,
  useBulkDeletePages,
  useBulkMoveFolders,
  useBulkMovePages,
  useBulkRemoveEntities,
} from './use-bulk-actions';
import { useFavorites } from './use-favorites';
import { usePageCollaborators } from './use-page-collaborators';

describe('bulk removal planning', () => {
  it('trashes only owned items and personally removes every eligible non-owned item', () => {
    const input = buildBulkRemovalInput(
      [
        { id: 'owned-page', type: 'page', ownerId: 'user-1' },
        {
          id: 'admin-page',
          type: 'page',
          ownerId: 'owner-1',
          userPermission: 'admin',
          shareSource: 'direct',
        },
        {
          id: 'public-folder',
          type: 'folder',
          ownerId: 'owner-1',
          shareSource: 'public',
        },
        {
          id: 'workspace-page',
          type: 'page',
          ownerId: 'owner-1',
          shareSource: 'workspace',
        },
      ],
      'user-1',
    );

    expect(input).toEqual({
      pageIdsToDelete: ['owned-page'],
      folderIdsToDelete: [],
      pageIdsToLeave: ['admin-page'],
      folderIdsToLeave: ['public-folder'],
    });
    expect(getBulkRemovalCounts(input)).toEqual({ trashCount: 1, removeFromViewCount: 2 });
  });
});

function createIdentityWrapper(
  queryClient: ReturnType<typeof createTestQueryClient>,
  lifecycle: ReturnType<typeof createIdentityLifecycle>,
) {
  return ({ children }: { children: ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(IdentityLifecycleProvider, { lifecycle }, children),
    );
}

describe('useBulkRemoveEntities', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    toastMocks.showSuccessToast.mockReset();
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('removes mixed owned and shared items with one refresh and toast', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const { result } = renderHook(() => useBulkRemoveEntities(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      pageIdsToDelete: ['owned-page'],
      folderIdsToDelete: ['owned-folder'],
      pageIdsToLeave: ['shared-page'],
      folderIdsToLeave: ['shared-folder'],
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/owned-page',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/pages/shared-page/leave', {
      method: 'POST',
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(14);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pageTree'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['folderTree'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-memberships'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-members'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shares'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pages', 'detail'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tags'] });
    expect(toastMocks.showSuccessToast).toHaveBeenCalledOnce();
    expect(toastMocks.showSuccessToast).toHaveBeenCalledWith(
      'Moved 2 items to Trash; removed 2 items from your view',
    );
  });

  it('cancels in-flight refreshes before issuing removal requests', async () => {
    let finishCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries').mockReturnValue(cancellation);
    fetchMock.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBulkRemoveEntities(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      pageIdsToDelete: ['owned-page'],
      folderIdsToDelete: [],
      pageIdsToLeave: [],
      folderIdsToLeave: [],
    });

    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledTimes(14);
    });
    expect(isBulkRemovalInProgress()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    finishCancellation?.();
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(isBulkRemovalInProgress()).toBe(false);
  });

  it('suppresses new focus refreshes while removal requests are pending', async () => {
    let finishRemoval: (() => void) | undefined;
    const removal = new Promise<{ ok: boolean }>((resolve) => {
      finishRemoval = () => resolve({ ok: true });
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return removal;
      if (url.endsWith('/favorites')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ favorites: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(
      () => {
        const bulkRemoval = useBulkRemoveEntities();
        useFavorites();
        usePageCollaborators(['page-1']);
        return bulkRemoval;
      },
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await queryClient.invalidateQueries({ queryKey: ['favorites'], refetchType: 'none' });
    await queryClient.invalidateQueries({ queryKey: ['pageCollaborators'], refetchType: 'none' });

    result.current.mutate({
      pageIdsToDelete: ['owned-page'],
      folderIdsToDelete: [],
      pageIdsToLeave: [],
      folderIdsToLeave: [],
    });
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    finishRemoval?.();
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('holds metadata refreshes until the final bulk refresh completes', async () => {
    let resolveResponse: ((value: { ok: boolean }) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    const { result } = renderHook(() => useBulkRemoveEntities(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      pageIdsToDelete: ['owned-page'],
      folderIdsToDelete: [],
      pageIdsToLeave: [],
      folderIdsToLeave: [],
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    expect(isBulkRemovalInProgress()).toBe(true);

    resolveResponse?.({ ok: true });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(isBulkRemovalInProgress()).toBe(false);
  });

  it('attempts every removal and reports a partial failure', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: !url.endsWith('/failed-page'),
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const { result } = renderHook(() => useBulkRemoveEntities(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      pageIdsToDelete: ['failed-page', 'owned-page'],
      folderIdsToDelete: [],
      pageIdsToLeave: ['shared-page'],
      folderIdsToLeave: [],
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeInstanceOf(BulkRemovalError);
    expect(result.current.error?.message).toBe('2 removed, 1 failed');
    expect((result.current.error as BulkRemovalError).result).toEqual({
      removedItems: [
        { id: 'owned-page', type: 'page' },
        { id: 'shared-page', type: 'page' },
      ],
      failedItems: [{ id: 'failed-page', type: 'page' }],
      trashedCount: 1,
      removedFromViewCount: 1,
    });
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
  });

  it('does not start a later request group after its identity retires', async () => {
    let finishOwnedDelete: (() => void) | undefined;
    const ownedDelete = new Promise<{ ok: boolean }>((resolve) => {
      finishOwnedDelete = () => resolve({ ok: true });
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/pages/owned-page') return ownedDelete;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
    const lifecycle = createIdentityLifecycle();
    const wrapper = createIdentityWrapper(queryClient, lifecycle);
    const { result } = renderHook(() => useBulkRemoveEntities(), { wrapper });

    act(() => {
      result.current.mutate({
        pageIdsToDelete: ['owned-page'],
        folderIdsToDelete: [],
        pageIdsToLeave: ['shared-page'],
        folderIdsToLeave: [],
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    lifecycle.retire();
    finishOwnedDelete?.();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/pages/shared-page/leave', {
      method: 'POST',
    });
  });

  it('does not show completion feedback after retiring during final refresh', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    let finishRefresh: (() => void) | undefined;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(refresh);
    const lifecycle = createIdentityLifecycle();
    const { result } = renderHook(() => useBulkRemoveEntities(), {
      wrapper: createIdentityWrapper(queryClient, lifecycle),
    });

    act(() => {
      result.current.mutate({
        pageIdsToDelete: ['owned-page'],
        folderIdsToDelete: [],
        pageIdsToLeave: [],
        folderIdsToLeave: [],
      });
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(14));

    lifecycle.retire();
    finishRefresh?.();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
  });
});

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

  it('handles partial failure without reporting full success and refreshes stale lists', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pageTree'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['trashPages'] });
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

  it('reports a partial move failure without a false success message', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockResolvedValueOnce({ ok: true });
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useBulkMovePages(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ pageIds: ['p1', 'p2'], parentId: 'f1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pageTree'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shared-with-me'] });
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
