import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

const toastMocks = vi.hoisted(() => ({
  showSuccessToast: vi.fn(),
}));

vi.mock('./toast', () => ({
  showSuccessToast: toastMocks.showSuccessToast,
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useBulkLeaveEntities, useEntityDeletion } from './entity-actions';

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
