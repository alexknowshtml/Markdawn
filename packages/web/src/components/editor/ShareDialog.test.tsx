import type { ShareSummary } from '@markdawn/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../test-utils/render';
import { consumeSelfLeave } from '../../utils/leave-page';

const mocks = vi.hoisted(() => ({
  summary: null as ShareSummary | null,
  removeGrant: vi.fn(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'current-admin' } } }),
}));
vi.mock('../../hooks/use-share', () => ({
  useShareSummary: () => ({ data: mocks.summary, isLoading: false, error: null, refetch: vi.fn() }),
  useUpdatePublicPermission: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateInheritancePolicy: () => ({ mutate: vi.fn(), isPending: false }),
  useGrantEntityAccess: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveGrant: () => ({ mutate: mocks.removeGrant, isPending: false }),
  useUpdateGrantPermission: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { ShareDialog } from './ShareDialog';

function adminSummary(): ShareSummary {
  return {
    entity: {
      type: 'page',
      id: 'page-1',
      title: 'Shared page',
      ownerId: 'owner-1',
    },
    publicAccess: { permission: 'private', url: '/app/shared-page-page-1' },
    inheritance: { policy: 'inherit' },
    grants: [],
    accessors: [
      {
        grantId: null,
        userId: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Owner',
        isOwner: true,
      },
      {
        grantId: 'share-self',
        userId: 'current-admin',
        name: 'Current Admin',
        email: 'admin@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Direct Grant',
        isOwner: false,
      },
      {
        grantId: 'share-other-admin',
        userId: 'other-admin',
        name: 'Other Admin',
        email: 'other@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Direct Grant',
        isOwner: false,
      },
    ],
    accessSources: [
      {
        kind: 'owner',
        grantId: null,
        userId: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        avatarUrl: null,
        permission: 'admin',
        effectivePermission: 'admin',
        isWinning: true,
        isOwner: true,
        isManageable: false,
      },
      {
        kind: 'direct',
        grantId: 'share-self',
        userId: 'current-admin',
        name: 'Current Admin',
        email: 'admin@example.com',
        avatarUrl: null,
        permission: 'admin',
        effectivePermission: 'admin',
        isWinning: true,
        isOwner: false,
        isManageable: true,
      },
      {
        kind: 'direct',
        grantId: 'share-other-admin',
        userId: 'other-admin',
        name: 'Other Admin',
        email: 'other@example.com',
        avatarUrl: null,
        permission: 'admin',
        effectivePermission: 'admin',
        isWinning: true,
        isOwner: false,
        isManageable: true,
      },
    ],
    inheritedPublicAccess: [],
    userPermission: 'admin',
    capabilities: {
      canEdit: true,
      canDelete: true,
      canCopy: true,
    },
    permissionDetails: [],
    inheritedAccessors: [],
  };
}

describe('ShareDialog admin self-removal', () => {
  beforeEach(() => {
    mocks.summary = adminSummary();
    mocks.removeGrant.mockReset();
  });

  afterEach(() => {
    consumeSelfLeave('page-1');
  });

  it('lets a directly granted admin leave without controlling another admin', async () => {
    const summary = adminSummary();
    summary.accessSources.push({
      kind: 'folder',
      grantId: 'ancestor-folder-share',
      userId: 'current-admin',
      name: 'Current Admin',
      email: 'admin@example.com',
      avatarUrl: null,
      permission: 'view',
      effectivePermission: 'admin',
      isWinning: false,
      isOwner: false,
      isManageable: false,
      folderId: 'folder-1',
      folderName: 'Parent Folder',
    });
    mocks.summary = summary;
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <ShareDialog
        entityType="page"
        entityId="page-1"
        title="Shared page"
        embedded
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText('You')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Leave' })).toHaveLength(1);
    expect(screen.getByText('Other Admin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(mocks.removeGrant).toHaveBeenCalledWith('share-self', expect.any(Object));
  });

  it('does not let a user remove an inherited folder grant from a child page', () => {
    const summary = adminSummary();
    const ownerSource = summary.accessSources[0];
    if (!ownerSource) throw new Error('Expected the owner access source');
    summary.accessSources = [
      ownerSource,
      {
        kind: 'folder',
        grantId: 'ancestor-folder-share',
        userId: 'current-admin',
        name: 'Current Admin',
        email: 'admin@example.com',
        avatarUrl: null,
        permission: 'admin',
        effectivePermission: 'admin',
        isWinning: true,
        isOwner: false,
        isManageable: false,
        folderId: 'folder-1',
        folderName: 'Parent Folder',
      },
    ];
    mocks.summary = summary;

    render(
      <ShareDialog
        entityType="page"
        entityId="page-1"
        title="Shared page"
        embedded
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('via Parent Folder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
    expect(mocks.removeGrant).not.toHaveBeenCalled();
  });

  it('shows winning and fallback account sources independently', () => {
    const summary = adminSummary();
    const ownerSource = summary.accessSources[0];
    if (!ownerSource) throw new Error('Expected the owner access source');
    summary.accessSources = [
      ownerSource,
      {
        kind: 'direct',
        grantId: 'latent-direct',
        userId: 'recipient-1',
        name: 'Recipient',
        email: 'recipient@example.com',
        avatarUrl: null,
        permission: 'view',
        effectivePermission: 'edit',
        isWinning: false,
        isOwner: false,
        isManageable: true,
      },
      {
        kind: 'folder',
        grantId: 'folder-share',
        userId: 'recipient-1',
        name: 'Recipient',
        email: 'recipient@example.com',
        avatarUrl: null,
        permission: 'edit',
        effectivePermission: 'edit',
        isWinning: true,
        isOwner: false,
        isManageable: false,
        folderId: 'folder-1',
        folderName: 'Project Folder',
      },
    ];
    mocks.summary = summary;

    render(
      <ShareDialog
        entityType="page"
        entityId="page-1"
        title="Shared page"
        embedded
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Recipient')).toHaveLength(2);
    expect(screen.getByText('Direct Grant')).toBeInTheDocument();
    expect(screen.getByText('· Fallback')).toBeInTheDocument();
    expect(screen.getByText('via Project Folder')).toBeInTheDocument();
    expect(screen.getByText('· Effective')).toBeInTheDocument();
  });

  it('discloses inherited public access when direct public access is restricted', () => {
    const summary = adminSummary();
    summary.inheritedPublicAccess = [
      {
        entityId: 'folder-1',
        entityTitle: 'Public Folder',
        permission: 'edit',
        url: '/app/folder/public-folder-folder-1',
      },
    ];
    mocks.summary = summary;

    render(
      <ShareDialog
        entityType="page"
        entityId="page-1"
        title="Shared page"
        embedded
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Public access')).toBeInTheDocument();
    expect(screen.getByText('Inherited public access')).toBeInTheDocument();
    expect(screen.getByText('Anyone can edit')).toBeInTheDocument();
  });

  it('names the dialog, inheritance switch, grant input, and public access choice', () => {
    render(
      <ShareDialog entityType="page" entityId="page-1" title="Shared page" onClose={vi.fn()} />,
    );

    expect(screen.getByRole('dialog', { name: 'Share Shared page' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Restrict inherited access' })).not.toBeChecked();
    expect(
      screen.getByRole('textbox', { name: "Existing user's email address" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Public access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restricted', pressed: true })).toBeInTheDocument();
  });
});
