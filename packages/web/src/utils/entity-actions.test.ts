import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';
import { consumeSelfLeave } from './leave-page';

const toastMocks = vi.hoisted(() => ({
  showSuccessToast: vi.fn(),
}));

vi.mock('./toast', () => ({
  showSuccessToast: toastMocks.showSuccessToast,
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { canRenameEntity, useBulkLeaveEntities, useEntityDeletion } from './entity-actions';

describe('canRenameEntity', () => {
  it.each([
    ['owner page', { type: 'page' as const, ownerId: 'user-1' }, true],
    ['owner folder', { type: 'folder' as const, ownerId: 'user-1' }, true],
    ['editable page', { type: 'page' as const, userPermission: 'edit' as const }, true],
    ['editable folder', { type: 'folder' as const, userPermission: 'edit' as const }, false],
    ['admin folder', { type: 'folder' as const, userPermission: 'admin' as const }, true],
    ['view-only page', { type: 'page' as const, userPermission: 'view' as const }, false],
  ])('%s has the expected rename capability', (_label, entity, expected) => {
    expect(canRenameEntity(entity, 'user-1')).toBe(expected);
  });

  it('fails closed when no current user is resolved', () => {
    expect(canRenameEntity({ type: 'page', userPermission: 'admin' }, undefined)).toBe(false);
  });
});

describe('useBulkLeaveEntities', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    toastMocks.showSuccessToast.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('does not report deletion success while a folder awaits confirmation', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'FOLDER_NOT_EMPTY',
            requiresForce: true,
            childFolders: 1,
            childPages: 2,
            message: 'Folder is not empty',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ deleted: true }),
      });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'folder', currentUserId: 'owner-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    let initialResult: unknown;
    await act(async () => {
      initialResult = await result.current.handleDelete({
        id: 'folder-1',
        type: 'folder',
        ownerId: 'owner-1',
      });
    });

    expect(initialResult).toEqual(
      expect.objectContaining({ requiresForce: true, childFolders: 1, childPages: 2 }),
    );
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleDelete(
        { id: 'folder-1', type: 'folder', ownerId: 'owner-1' },
        { force: true },
      );
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/folders/folder-1?force=true', {
      method: 'DELETE',
    });
    expect(toastMocks.showSuccessToast).toHaveBeenCalledWith('Moved to trash');
  });

  it('does not report success for an undecodable delete response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'owner-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await expect(
      result.current.handleDelete({ id: 'page-1', type: 'page', ownerId: 'owner-1' }),
    ).rejects.toThrow('Invalid delete page response');
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not report success when a delete response omits its result', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'owner-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await expect(
      result.current.handleDelete({ id: 'page-1', type: 'page', ownerId: 'owner-1' }),
    ).rejects.toThrow('Invalid delete page response');
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
  });

  it('clears self-leave coordination when a direct page leave fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Leave failed' }),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'user-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await expect(
      result.current.handleDelete({
        id: 'shared-page',
        type: 'page',
        ownerId: 'owner-1',
        userPermission: 'view',
        shareSource: 'direct',
      }),
    ).rejects.toThrow('Leave failed');

    expect(consumeSelfLeave('shared-page')).toBe(false);
  });

  it('refreshes navigation after some leave requests succeed and another fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'Cannot leave inherited page' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useBulkLeaveEntities('page'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ entityIds: ['page-1', 'page-2', 'page-3'] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    for (const queryKey of [
      ['pageTree'],
      ['folderTree'],
      ['shared-with-me'],
      ['pages', 'recent'],
      ['favorites'],
    ]) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });
});
