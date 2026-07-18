import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useShareContext } from '../../contexts/ShareContext';
import { createTestQueryClient } from '../../test-utils/render';

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'viewer-1' } }, isPending: false }),
}));

import { ShareablePageRoute } from './ShareablePageRoute';

function AccessProbe() {
  const { capabilities } = useShareContext();
  return <output data-testid="can-edit">{String(capabilities.canEdit)}</output>;
}

function folderShares(permission: 'view' | 'edit') {
  return {
    entity: { type: 'folder', id: FOLDER_ID, title: 'Folder', ownerId: 'owner-1' },
    link: { permission: 'private' as const, token: null, url: null },
    accessors: [],
    userPermission: permission,
    capabilities: {
      canEdit: permission === 'edit',
      canComment: permission === 'edit',
      canDelete: false,
      canCopy: true,
    },
  };
}

describe('ShareablePageRoute folder access polling', () => {
  it('invalidates every access-sensitive cache when a polled permission changes', async () => {
    const queryClient = createTestQueryClient();
    const entityKey = ['folders', 'detail', FOLDER_ID] as const;
    const sharesKey = ['shares', 'entity', 'folder', FOLDER_ID] as const;
    queryClient.setQueryDefaults(entityKey, { staleTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryDefaults(sharesKey, { staleTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(entityKey, {
      id: FOLDER_ID,
      name: 'Folder',
      isPublic: false,
      linkPermission: null,
    });
    queryClient.setQueryData(sharesKey, folderShares('edit'));
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

    act(() => queryClient.setQueryData(sharesKey, folderShares('view')));

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
});
