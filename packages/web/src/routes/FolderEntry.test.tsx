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
  pagesError: new Error('page tree failed') as Error | null,
  foldersError: new Error('folder tree failed') as Error | null,
  clipboardState: { action: null, items: [] } as {
    action: 'copy' | 'cut' | null;
    items: Array<{ id: string; type: 'page' | 'folder' }>;
  },
  share: {
    capabilities: { canEdit: true, canDelete: true, canCopy: true },
    isAnonymous: false,
    publicEntity: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Fresh polled name',
      parentId: null,
      publicPermission: 'edit' as const,
      folders: [],
      pages: [],
    },
  },
  toolbarProps: vi.fn(),
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
  useShareContext: () => mocks.share,
}));
vi.mock('../contexts/ClipboardContext', () => ({
  useClipboard: () => ({ state: mocks.clipboardState, clear: vi.fn() }),
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
    error: mocks.pagesError,
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
        publicPermission: null,
        children: [],
      },
    ],
    isLoading: false,
    error: mocks.foldersError,
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
vi.mock('../components/workspace/SelectionToolbar', () => ({
  SelectionToolbar: (props: unknown) => {
    mocks.toolbarProps(props);
    return null;
  },
}));

import FolderEntry from './FolderEntry';

describe('FolderEntry access refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pagesError = new Error('page tree failed');
    mocks.foldersError = new Error('folder tree failed');
    mocks.clipboardState = { action: null, items: [] };
    mocks.share.capabilities = { canEdit: true, canDelete: true, canCopy: true };
  });

  it('uses fresh polled metadata for a router-aware canonical replace', async () => {
    render(
      <MemoryRouter initialEntries={[`/app/folder/stale-${FOLDER_ID}?mode=grid#section`]}>
        <Routes>
          <Route path="/app/folder/:slugAndId" element={<FolderEntry />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.navigate).toHaveBeenCalledWith(
      {
        pathname: buildFolderPath('Fresh polled name', FOLDER_ID),
        search: '?mode=grid',
        hash: '#section',
      },
      { replace: true },
    );
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

  it('allows editors to paste copies but not cut items', () => {
    mocks.pagesError = null;
    mocks.foldersError = null;
    mocks.share.capabilities = { canEdit: true, canDelete: false, canCopy: true };
    mocks.clipboardState = { action: 'copy', items: [{ id: 'page-1', type: 'page' }] };

    const rendered = render(
      <MemoryRouter initialEntries={[`/app/folder/fresh-${FOLDER_ID}`]}>
        <Routes>
          <Route path="/app/folder/:slugAndId" element={<FolderEntry />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.toolbarProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ canPaste: true, canMove: false }),
    );

    mocks.clipboardState = { action: 'cut', items: [{ id: 'page-1', type: 'page' }] };
    rendered.rerender(
      <MemoryRouter initialEntries={[`/app/folder/fresh-${FOLDER_ID}`]}>
        <Routes>
          <Route path="/app/folder/:slugAndId" element={<FolderEntry />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.toolbarProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ canPaste: false, canMove: false }),
    );
  });
});
