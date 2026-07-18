import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFolderPath } from '../utils/url';

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refetchPages: vi.fn(),
  refetchFolders: vi.fn(),
  idleMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('../contexts/ShareContext', () => ({
  useShareContext: () => ({
    capabilities: { canEdit: true, canComment: true, canDelete: true, canCopy: true },
    isAnonymous: false,
    publicEntity: {
      id: FOLDER_ID,
      name: 'Fresh polled name',
      parentId: null,
      folders: [],
      pages: [],
    },
  }),
}));
vi.mock('../contexts/ClipboardContext', () => ({
  useClipboard: () => ({ state: { action: null, items: [] }, clear: vi.fn() }),
}));
vi.mock('../contexts/SelectionContext', () => ({
  useSelection: () => ({
    selectedItems: [],
    selectedCount: 0,
    clear: vi.fn(),
    toggle: vi.fn(),
    selectAll: vi.fn(),
    isSelected: () => false,
  }),
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'owner-1' } } }),
}));

vi.mock('../hooks/use-pages', () => ({
  usePageTree: () => ({
    data: [],
    isLoading: false,
    error: new Error('page tree failed'),
    refetch: mocks.refetchPages,
  }),
  useCreatePage: mocks.idleMutation,
  useUpdatePage: mocks.idleMutation,
}));
vi.mock('../hooks/use-folders', () => ({
  useFolderTree: () => ({
    data: [
      {
        id: FOLDER_ID,
        parentId: null,
        name: 'Stale tree name',
        icon: null,
        position: 'a0',
        createdBy: 'owner-1',
        ownerId: 'owner-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        publicToken: null,
        children: [],
      },
    ],
    isLoading: false,
    error: new Error('folder tree failed'),
    refetch: mocks.refetchFolders,
  }),
  useCreateFolder: mocks.idleMutation,
  useUpdateFolder: mocks.idleMutation,
}));
vi.mock('../hooks/use-favorites', () => ({ useFavorites: () => ({ data: [] }) }));
vi.mock('../hooks/use-workspace', () => ({ useWorkspaceMemberships: () => ({ data: [] }) }));
vi.mock('../hooks/use-page-collaborators', () => ({
  usePageCollaborators: () => ({ data: {} }),
  useFolderCollaborators: () => ({ data: {} }),
}));
vi.mock('../hooks/use-bulk-actions', () => ({
  BulkRemovalError: class BulkRemovalError extends Error {},
  useBulkMoveFolders: mocks.idleMutation,
  useBulkMovePages: mocks.idleMutation,
  useBulkRemoveEntities: mocks.idleMutation,
}));
vi.mock('../hooks/use-copy', () => ({
  useCopyFolder: mocks.idleMutation,
  useCopyPage: mocks.idleMutation,
}));
vi.mock('../components/workspace/ExplorerItem', () => ({ ExplorerItem: () => null }));
vi.mock('../components/workspace/MoveDialog', () => ({ MoveDialog: () => null }));
vi.mock('../components/workspace/SelectionToolbar', () => ({ SelectionToolbar: () => null }));

import FolderEntry from './FolderEntry';

describe('FolderEntry access refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses fresh polled metadata for a router-aware canonical replace', async () => {
    render(
      <MemoryRouter initialEntries={[`/app/folder/stale-${FOLDER_ID}`]}>
        <Routes>
          <Route path="/app/folder/:slugAndId" element={<FolderEntry />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.navigate).toHaveBeenCalledWith(buildFolderPath('Fresh polled name', FOLDER_ID), {
      replace: true,
    });
  });

  it('retries both page and folder trees after either fails', async () => {
    const user = userEvent.setup();
    mocks.refetchPages.mockResolvedValue(undefined);
    mocks.refetchFolders.mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={[`/app/folder/stale-${FOLDER_ID}`]}>
        <Routes>
          <Route path="/app/folder/:slugAndId" element={<FolderEntry />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchPages).toHaveBeenCalledOnce();
    expect(mocks.refetchFolders).toHaveBeenCalledOnce();
  });
});
