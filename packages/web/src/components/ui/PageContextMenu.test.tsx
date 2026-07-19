import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardProvider } from '../../contexts/ClipboardContext';
import { render } from '../../test-utils/render';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useShareContext: vi.fn(),
  moveToTrash: vi.fn(),
  removeFromView: vi.fn(),
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
    useEntityDeletion: ({ onSuccess }: { onSuccess?: () => void }) => ({
      moveToTrash: async (entity: unknown, options: unknown) => {
        const result = await mocks.moveToTrash(entity, options);
        onSuccess?.();
        return result;
      },
      removeFromView: async (entity: unknown) => {
        await mocks.removeFromView(entity);
        onSuccess?.();
      },
      isPending: false,
    }),
  };
});
vi.mock('../editor/ShareDialog', () => ({ ShareDialog: () => null }));
vi.mock('../workspace/MoveDialog', () => ({
  MoveDialog: (props: unknown) => {
    mocks.moveDialogProps(props);
    return null;
  },
}));
vi.mock('./KebabMenu', () => ({
  KebabMenu: ({
    items,
  }: {
    items: Array<{ label: string; onClick: () => void; dividerBefore?: boolean }>;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.label}>
          {item.dividerBefore && <hr />}
          <button type="button" onClick={item.onClick}>
            {item.label}
          </button>
        </div>
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
  onCopy,
  onDeleted,
}: {
  permission?: Permission | undefined;
  ownerId?: string | undefined;
  shareSource?: 'direct' | 'public' | 'workspace' | undefined;
  createdBy?: string | undefined;
  anonymous?: boolean | undefined;
  entityType?: 'page' | 'folder';
  onCopy?: (() => void) | undefined;
  onDeleted?: (() => void) | undefined;
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
        {...(onCopy ? { onCopy } : {})}
        {...(onDeleted ? { onDeleted } : {})}
      />
    </ClipboardProvider>,
  );
}

function labels(): string[] {
  return screen.queryAllByRole('button').map((button) => button.textContent ?? '');
}

function lastButton(name: string): HTMLElement {
  const button = screen.getAllByRole('button', { name }).at(-1);
  if (!button) throw new Error(`Expected a button named ${name}`);
  return button;
}

describe('PageContextMenu permissions', () => {
  beforeEach(() => {
    mocks.moveToTrash.mockReset();
    mocks.moveToTrash.mockResolvedValue({ deleted: true });
    mocks.removeFromView.mockReset();
    mocks.removeFromView.mockResolvedValue(undefined);
    mocks.memberships = [];
    mocks.moveDialogProps.mockReset();
  });

  it('hides signed-in-only actions from anonymous viewers and editors', () => {
    renderMenu({ permission: 'edit', shareSource: 'public', anonymous: true });

    expect(labels()).not.toContain('Copy');
    expect(labels()).not.toContain('Export');
    expect(labels()).not.toContain('Move');
    expect(labels()).not.toContain('Move to Trash');
    expect(labels()).not.toContain('Favorite');
    expect(labels()).not.toContain('Share');
  });

  it('offers an immediate copy action to a guest when the destination allows it', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    renderMenu({ permission: 'edit', shareSource: 'public', anonymous: true, onCopy });

    expect(labels()).toEqual(['Copy']);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it.each([
    {
      role: 'viewer',
      permission: 'view' as const,
      expected: ['Favorite', 'Share', 'Export', 'Copy'],
      absent: ['Rename', 'Move', 'Move to Trash', 'Remove from my view'],
    },
    {
      role: 'editor',
      permission: 'edit' as const,
      expected: ['Favorite', 'Rename', 'Share', 'Export', 'Copy'],
      absent: ['Move', 'Move to Trash', 'Remove from my view'],
    },
    {
      role: 'admin',
      permission: 'admin' as const,
      expected: ['Favorite', 'Rename', 'Share', 'Export', 'Move to Trash', 'Move', 'Copy'],
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
      expect.arrayContaining(['Rename', 'Share', 'Export', 'Move to Trash', 'Move', 'Copy']),
    );
  });

  it.each([
    'direct',
    'public',
  ] as const)('removes a directly shared viewer item via %s access', async (shareSource) => {
    const user = userEvent.setup();
    renderMenu({ permission: 'view', shareSource });

    await user.click(lastButton('Remove from my view'));
    expect(mocks.removeFromView).not.toHaveBeenCalled();
    expect(screen.getByText('Remove “Test page” from your view?')).toBeInTheDocument();
    await user.click(lastButton('Remove from my view'));

    await waitFor(() =>
      expect(mocks.removeFromView).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'page-1', shareSource }),
      ),
    );
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
  });

  it('does not offer personal removal for workspace-inherited access', () => {
    renderMenu({ permission: 'view', shareSource: 'workspace' });

    expect(screen.queryByRole('button', { name: 'Remove from my view' })).not.toBeInTheDocument();
  });

  it('offers a direct-share admin distinct trash and personal-removal actions', () => {
    renderMenu({ permission: 'admin', shareSource: 'direct' });

    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from my view' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('never offers personal removal to the owner', () => {
    renderMenu({ ownerId: 'current-user', shareSource: 'direct' });

    expect(screen.queryByRole('button', { name: 'Remove from my view' })).not.toBeInTheDocument();
  });

  it('confirms before moving a folder and its contents to Trash', async () => {
    const user = userEvent.setup();
    renderMenu({ permission: 'admin', entityType: 'folder' });

    await user.click(lastButton('Move to Trash'));
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(screen.getByText(/folder and all of its contents/)).toBeInTheDocument();

    await user.click(lastButton('Move to Trash'));

    expect(mocks.moveToTrash).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page-1', type: 'folder' }),
      { force: true },
    );
  });

  it('confirms the non-owner admin trash action without using personal removal', async () => {
    const user = userEvent.setup();
    renderMenu({ permission: 'admin', shareSource: 'direct' });

    await user.click(lastButton('Move to Trash'));
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    await user.click(lastButton('Move to Trash'));

    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledOnce());
    expect(mocks.moveToTrash).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page-1', type: 'page', title: 'Test page' }),
      { force: false },
    );
    expect(mocks.removeFromView).not.toHaveBeenCalled();
  });

  it('keeps a non-owner admin personal removal separate from moving to Trash', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    renderMenu({ permission: 'admin', shareSource: 'direct', onDeleted });

    await user.click(lastButton('Remove from my view'));
    await user.click(lastButton('Remove from my view'));

    await waitFor(() => expect(mocks.removeFromView).toHaveBeenCalledOnce());
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledOnce();
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
