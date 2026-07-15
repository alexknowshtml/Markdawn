import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardProvider } from '../../contexts/ClipboardContext';
import { render } from '../../test-utils/render';
import { consumeSelfLeave } from '../../utils/leave-page';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useShareContext: vi.fn(),
  handleDelete: vi.fn(),
  leaveEntity: vi.fn(),
  memberships: [] as Array<{ ownerId: string; role: 'viewer' | 'editor' | 'admin' }>,
  moveDialogProps: vi.fn(),
}));

vi.mock('../../hooks/useAuth', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/ShareContext', () => ({
  useShareContext: mocks.useShareContext,
}));
vi.mock('../../hooks/use-bulk-actions', () => ({
  useBulkMoveFolders: () => ({ mutate: vi.fn() }),
  useBulkMovePages: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../hooks/use-favorites', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../hooks/use-folders', () => ({
  useFolderTree: () => ({ data: [] }),
}));
vi.mock('../../hooks/use-workspace', () => ({
  useWorkspaceMemberships: () => ({ data: mocks.memberships }),
}));
vi.mock('../../utils/entity-actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/entity-actions')>();
  return {
    ...original,
    useEntityDeletion: () => ({ handleDelete: mocks.handleDelete, isPending: false }),
    useLeaveEntity: () => ({ mutateAsync: mocks.leaveEntity, isPending: false }),
  };
});
vi.mock('../editor/PublicShareDialog', () => ({ PublicShareDialog: () => null }));
vi.mock('../workspace/MoveDialog', () => ({
  MoveDialog: (props: unknown) => {
    mocks.moveDialogProps(props);
    return null;
  },
}));
vi.mock('./KebabMenu', () => ({
  KebabMenu: ({ items }: { items: Array<{ label: string; onClick: () => void }> }) => (
    <div>
      {items.map((item) => (
        <button type="button" key={item.label} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

import { PageContextMenu } from './PageContextMenu';

type Permission = 'view' | 'edit' | 'admin';

function renderMenu({
  permission,
  ownerId = 'owner-1',
  shareSource,
  createdBy,
  anonymous = false,
  entityType = 'page',
}: {
  permission?: Permission | undefined;
  ownerId?: string | undefined;
  shareSource?: 'direct' | 'link' | 'workspace' | undefined;
  createdBy?: string | undefined;
  anonymous?: boolean | undefined;
  entityType?: 'page' | 'folder';
}) {
  mocks.useAuth.mockReturnValue({
    data: anonymous ? { user: null } : { user: { id: 'current-user' } },
  });
  mocks.useShareContext.mockReturnValue({ isAnonymous: anonymous });

  return render(
    <ClipboardProvider>
      <PageContextMenu
        item={{
          id: 'page-1',
          type: entityType,
          title: entityType === 'folder' ? 'Test folder' : 'Test page',
          ownerId,
          userPermission: permission,
          ...(shareSource ? { shareSource } : {}),
          ...(createdBy ? { createdBy } : {}),
        }}
        onRename={vi.fn()}
      />
    </ClipboardProvider>,
  );
}

function labels(): string[] {
  return screen.getAllByRole('button').map((button) => button.textContent ?? '');
}

describe('PageContextMenu permissions', () => {
  beforeEach(() => {
    mocks.handleDelete.mockReset();
    mocks.handleDelete.mockResolvedValue({ deleted: true });
    mocks.leaveEntity.mockReset();
    mocks.leaveEntity.mockResolvedValue({ ok: true });
    mocks.memberships = [];
    mocks.moveDialogProps.mockReset();
  });

  afterEach(() => {
    consumeSelfLeave('page-1');
  });

  it('hides signed-in-only actions from anonymous viewers and editors', () => {
    renderMenu({ permission: 'edit', shareSource: 'link', anonymous: true });

    expect(labels()).not.toContain('Copy');
    expect(labels()).not.toContain('Export');
    expect(labels()).not.toContain('Move');
    expect(labels()).not.toContain('Delete');
  });

  it.each([
    {
      role: 'viewer',
      permission: 'view' as const,
      expected: ['Favorite', 'Share', 'Export', 'Copy'],
      absent: ['Rename', 'Move', 'Delete'],
    },
    {
      role: 'editor',
      permission: 'edit' as const,
      expected: ['Favorite', 'Rename', 'Share', 'Export', 'Copy'],
      absent: ['Move', 'Delete'],
    },
    {
      role: 'admin',
      permission: 'admin' as const,
      expected: ['Favorite', 'Rename', 'Share', 'Export', 'Delete', 'Move', 'Copy'],
      absent: [],
    },
  ])('renders the $role action boundary', ({ permission, expected, absent }) => {
    renderMenu({ permission });
    const menuLabels = labels();

    for (const label of expected) expect(menuLabels).toContain(label);
    for (const label of absent) expect(menuLabels).not.toContain(label);
  });

  it('renders owner actions even without an explicit permission', () => {
    renderMenu({ ownerId: 'current-user' });

    expect(labels()).toEqual(
      expect.arrayContaining(['Rename', 'Share', 'Export', 'Delete', 'Move', 'Copy']),
    );
  });

  it.each([
    'direct',
    'link',
  ] as const)('lets a directly shared viewer leave via %s access', async (shareSource) => {
    const user = userEvent.setup();
    renderMenu({ permission: 'view', shareSource });

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(mocks.leaveEntity).toHaveBeenCalledWith('page-1');
  });

  it('does not offer item-level leave for workspace-inherited access', () => {
    renderMenu({ permission: 'view', shareSource: 'workspace' });

    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
  });

  it('offers a direct-share admin both structural deletion and self-leave', () => {
    renderMenu({ permission: 'admin', shareSource: 'direct' });

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  it('never offers leave to the owner', () => {
    renderMenu({ ownerId: 'current-user', shareSource: 'direct' });

    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
  });

  it('confirms before recursively deleting a non-empty folder', async () => {
    const user = userEvent.setup();
    mocks.handleDelete
      .mockResolvedValueOnce({
        requiresForce: true,
        childFolders: 2,
        childPages: 3,
        message: 'Folder is not empty',
      })
      .mockResolvedValueOnce({ deleted: true });
    renderMenu({ permission: 'admin', entityType: 'folder' });

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mocks.handleDelete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'page-1', type: 'folder' }),
      { force: false },
    );
    expect(screen.getByText(/2 nested folders and 3 pages/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move to trash' }));

    expect(mocks.handleDelete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'page-1', type: 'folder' }),
      { force: true },
    );
  });

  it.each([
    { createdBy: 'workspace-owner', allowRoot: true },
    { createdBy: 'current-user', allowRoot: false },
  ])('sets root move availability to $allowRoot when the creator is $createdBy', ({
    createdBy,
    allowRoot,
  }) => {
    mocks.memberships = [{ ownerId: 'workspace-owner', role: 'admin' }];
    renderMenu({ permission: 'admin', ownerId: 'workspace-owner', createdBy });

    expect(mocks.moveDialogProps).toHaveBeenLastCalledWith(expect.objectContaining({ allowRoot }));
  });
});
