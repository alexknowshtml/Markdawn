import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useShareContext } from '../../contexts/ShareContext';
import { createTestQueryClient } from '../../test-utils/render';

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'viewer-1' } }, isPending: false }),
}));

import { ShareablePageRoute } from './ShareablePageRoute';

function AccessProbe() {
  const { capabilities } = useShareContext();
  return <output data-testid="can-edit">{String(capabilities.canEdit)}</output>;
}

function folderEntity(permission: 'view' | 'edit') {
  return {
    accessScope: 'account' as const,
    id: FOLDER_ID,
    parentId: null,
    name: 'Folder',
    icon: null,
    position: 'a0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publicPermission: null,
    createdBy: 'owner-1',
    ownerId: 'owner-1',
    userPermission: permission,
    inheritancePolicy: 'inherit',
    capabilities: {
      canEdit: permission === 'edit',
      canDelete: false,
      canCopy: true,
    },
    pages: [],
    folders: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShareablePageRoute folder access polling', () => {
  it('invalidates every access-sensitive cache when a polled permission changes', async () => {
    const queryClient = createTestQueryClient();
    const entityKey = ['folders', 'detail', FOLDER_ID] as const;
    queryClient.setQueryDefaults(entityKey, { staleTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(entityKey, folderEntity('edit'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/app/folder/folder-${FOLDER_ID}`]}>
          <Routes>
            <Route
              path="/app/folder/:slugAndId"
              element={
                <ShareablePageRoute entityType="folder">
                  <AccessProbe />
                </ShareablePageRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('can-edit')).toHaveTextContent('true');
    invalidateSpy.mockClear();

    act(() => queryClient.setQueryData(entityKey, folderEntity('view')));

    await waitFor(() => expect(screen.getByTestId('can-edit')).toHaveTextContent('false'));
    for (const queryKey of [
      ['pageTree'],
      ['folderTree'],
      ['pages', 'recent'],
      ['shares'],
      ['pageCollaborators'],
      ['folderCollaborators'],
      ['pages', 'detail'],
      ['folders', 'detail'],
    ]) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('keeps the complete response in the page-detail cache after access validation', async () => {
    const queryClient = createTestQueryClient();
    const pageDetailKey = ['pages', 'detail', PAGE_ID] as const;
    const completePage = { id: PAGE_ID, title: 'Complete page title', icon: 'C' };
    queryClient.setQueryData(pageDetailKey, completePage);
    const responsePage = {
      accessScope: 'public',
      id: PAGE_ID,
      title: 'Shared page title',
      icon: 'S',
      coverType: null,
      coverValue: null,
      properties: null,
      updatedAt: null,
      publicPermission: 'view',
      userPermission: 'view',
      capabilities: { canEdit: false, canDelete: false, canCopy: true },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(responsePage), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/app/page/page-${PAGE_ID}`]}>
          <Routes>
            <Route
              path="/app/page/:slugAndId"
              element={
                <ShareablePageRoute entityType="page">
                  <AccessProbe />
                </ShareablePageRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(pageDetailKey)).toEqual(responsePage);
  });
});
