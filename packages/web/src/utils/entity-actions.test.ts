import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFolderTreeNode, createMockPageTreeNode } from '../test-utils/factories';
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

import {
  canRenameEntity,
  resolveRemovalShareSource,
  useBulkLeaveEntities,
  useEntityDeletion,
} from './entity-actions';

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

describe('resolveRemovalShareSource', () => {
  it('hides personal removal when workspace access would remain after a direct grant is removed', () => {
    expect(resolveRemovalShareSource('direct', true)).toBe('workspace');
    expect(resolveRemovalShareSource('public', true)).toBe('workspace');
  });

  it('preserves directly removable provenance without workspace inheritance', () => {
    expect(resolveRemovalShareSource('direct', false)).toBe('direct');
    expect(resolveRemovalShareSource('public', false)).toBe('public');
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
      initialResult = await result.current.moveToTrash({
        id: 'folder-1',
        type: 'folder',
        title: 'Project',
        ownerId: 'owner-1',
      });
    });

    expect(initialResult).toEqual(
      expect.objectContaining({ requiresForce: true, childFolders: 1, childPages: 2 }),
    );
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.moveToTrash(
        { id: 'folder-1', type: 'folder', title: 'Project', ownerId: 'owner-1' },
        { force: true },
      );
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/folders/folder-1?force=true', {
      method: 'DELETE',
    });
    expect(toastMocks.showSuccessToast).toHaveBeenCalledWith('Moved "Project" To Trash');
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
      result.current.moveToTrash({
        id: 'page-1',
        type: 'page',
        title: 'Broken page',
        ownerId: 'owner-1',
      }),
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
      result.current.moveToTrash({
        id: 'page-1',
        type: 'page',
        title: 'Broken page',
        ownerId: 'owner-1',
      }),
    ).rejects.toThrow('Invalid delete page response');
    expect(toastMocks.showSuccessToast).not.toHaveBeenCalled();
  });

  it('removes a confirmed page deletion from navigation caches before reporting success', async () => {
    const deleted = createMockPageTreeNode({ id: 'page-1' });
    const remaining = createMockPageTreeNode({ id: 'page-2' });
    queryClient.setQueryData(['pageTree'], [deleted, remaining]);
    queryClient.setQueryData(
      ['pages', 'recent', 8],
      [
        { id: 'page-1', title: 'Deleted' },
        { id: 'page-2', title: 'Remaining' },
      ],
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'owner-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.moveToTrash({
        id: 'page-1',
        type: 'page',
        title: 'Deleted',
        ownerId: 'owner-1',
      });
    });

    expect(queryClient.getQueryData(['pageTree'])).toEqual([remaining]);
    expect(queryClient.getQueryData(['pages', 'recent', 8])).toEqual([
      { id: 'page-2', title: 'Remaining' },
    ]);
    expect(consumeSelfLeave('page-1')).toBe(true);
  });

  it('removes a confirmed folder subtree and its pages from navigation caches', async () => {
    const childFolder = createMockFolderTreeNode({ id: 'folder-child', parentId: 'folder-1' });
    const deletedFolder = createMockFolderTreeNode({
      id: 'folder-1',
      children: [childFolder],
    });
    const childPage = createMockPageTreeNode({ id: 'page-1', parentId: childFolder.id });
    const remainingPage = createMockPageTreeNode({ id: 'page-2' });
    queryClient.setQueryData(['folderTree'], [deletedFolder]);
    queryClient.setQueryData(['pageTree'], [childPage, remainingPage]);
    queryClient.setQueryData(
      ['pages', 'recent', 8],
      [
        { id: 'page-1', title: 'Deleted' },
        { id: 'page-2', title: 'Remaining' },
      ],
    );
    queryClient.setQueryData(
      ['favorites'],
      [
        { entityType: 'folder', entityId: 'folder-child', title: 'Child folder' },
        { entityType: 'page', entityId: 'page-1', title: 'Child page' },
      ],
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'folder', currentUserId: 'owner-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.moveToTrash(
        { id: 'folder-1', type: 'folder', title: 'Project', ownerId: 'owner-1' },
        { force: true },
      );
    });

    expect(queryClient.getQueryData(['folderTree'])).toEqual([]);
    expect(queryClient.getQueryData(['pageTree'])).toEqual([remainingPage]);
    expect(queryClient.getQueryData(['pages', 'recent', 8])).toEqual([
      { id: 'page-2', title: 'Remaining' },
    ]);
    expect(queryClient.getQueryData(['favorites'])).toEqual([]);
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
      result.current.removeFromView({
        id: 'shared-page',
        type: 'page',
        title: 'Shared page',
        ownerId: 'owner-1',
        userPermission: 'view',
        shareSource: 'direct',
      }),
    ).rejects.toThrow('Leave failed');

    expect(consumeSelfLeave('shared-page')).toBe(false);
  });

  it('uses personal removal for a directly shared non-owner admin', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'admin-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.removeFromView({
        id: 'shared-page',
        type: 'page',
        title: 'Shared roadmap',
        ownerId: 'owner-1',
        userPermission: 'admin',
        shareSource: 'direct',
      });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/pages/shared-page/leave', { method: 'POST' });
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/pages/shared-page',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(toastMocks.showSuccessToast).toHaveBeenCalledWith(
      '“Shared roadmap” removed from your view',
    );
    expect(consumeSelfLeave('shared-page')).toBe(true);
  });

  it('keeps the explicit trash action available to a non-owner admin', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    });
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'admin-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.moveToTrash({
        id: 'shared-page',
        type: 'page',
        title: 'Shared roadmap',
        ownerId: 'owner-1',
        userPermission: 'admin',
        shareSource: 'direct',
      });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/pages/shared-page', { method: 'DELETE' });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/pages/shared-page/leave', { method: 'POST' });
    expect(toastMocks.showSuccessToast).toHaveBeenCalledWith('Moved "Shared roadmap" To Trash');
    expect(consumeSelfLeave('shared-page')).toBe(true);
  });

  it('rejects personal removal for workspace-inherited access without a request', async () => {
    const { result } = renderHook(
      () => useEntityDeletion({ entityType: 'page', currentUserId: 'admin-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    await expect(
      result.current.removeFromView({
        id: 'workspace-page',
        type: 'page',
        title: 'Workspace page',
        ownerId: 'owner-1',
        userPermission: 'admin',
        shareSource: 'workspace',
      }),
    ).rejects.toThrow('inherits access and cannot be removed directly');

    expect(fetchMock).not.toHaveBeenCalled();
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
