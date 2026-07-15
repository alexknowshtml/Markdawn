import type { ShareSummary } from '@markdawn/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../test-utils/render';
import { consumeSelfLeave } from '../../utils/leave-page';

const mocks = vi.hoisted(() => ({
  summary: null as ShareSummary | null,
  removeShare: vi.fn(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'current-admin' } } }),
}));
vi.mock('../../hooks/use-share', () => ({
  useShareSummary: () => ({ data: mocks.summary, isLoading: false }),
  useUpdateLinkPermission: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateInheritancePolicy: () => ({ mutate: vi.fn(), isPending: false }),
  useInviteToEntity: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveShare: () => ({ mutate: mocks.removeShare, isPending: false }),
  useUpdateSharePermission: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { PublicShareDialog } from './PublicShareDialog';

function adminSummary(): ShareSummary {
  return {
    entity: {
      type: 'page',
      id: 'page-1',
      title: 'Shared page',
      ownerId: 'owner-1',
    },
    link: { permission: 'private', token: null, url: null },
    inheritance: { policy: 'inherit' },
    invites: [],
    accessors: [
      {
        shareId: null,
        userId: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Owner',
        isOwner: true,
      },
      {
        shareId: 'share-self',
        userId: 'current-admin',
        name: 'Current Admin',
        email: 'admin@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Direct Invite',
        isOwner: false,
      },
      {
        shareId: 'share-other-admin',
        userId: 'other-admin',
        name: 'Other Admin',
        email: 'other@example.com',
        avatarUrl: null,
        permission: 'admin',
        source: 'Direct Invite',
        isOwner: false,
      },
    ],
    userPermission: 'admin',
    capabilities: {
      canEdit: true,
      canComment: true,
      canDelete: true,
      canCopy: true,
    },
    permissionDetails: [],
    inheritedAccessors: [],
  };
}

describe('PublicShareDialog admin self-removal', () => {
  beforeEach(() => {
    mocks.summary = adminSummary();
    mocks.removeShare.mockReset();
  });

  afterEach(() => {
    consumeSelfLeave('page-1');
  });

  it('lets a directly invited admin leave without granting control over another admin', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <PublicShareDialog
        entityType="page"
        entityId="page-1"
        title="Shared page"
        embedded
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.getByText('Other Admin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(mocks.removeShare).toHaveBeenCalledWith('share-self', expect.any(Object));
  });
});
