import type { FolderTreeNode, PageTreeNode, SharedNavigationItem } from '@markdawn/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceMembership } from '../../hooks/use-workspace';
import { createMockFolderTreeNode, createMockPageTreeNode } from '../../test-utils/factories';
import { render } from '../../test-utils/render';

const mocks = vi.hoisted(() => ({
  pages: [] as PageTreeNode[],
  folders: [] as FolderTreeNode[],
  shared: [] as SharedNavigationItem[],
  memberships: [] as WorkspaceMembership[],
  leaveWorkspace: vi.fn(),
}));

vi.mock('../../contexts/ShareContext', () => ({
  useShareContext: () => ({ isAnonymous: false }),
}));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ data: { user: { id: 'current-user' } } }),
}));
vi.mock('../../hooks/use-favorites', () => ({
  useFavorites: () => ({ data: [] }),
}));
vi.mock('../../hooks/use-folders', () => ({
  useFolderTree: () => ({ data: mocks.folders, isLoading: false, error: null }),
  useCreateFolder: () => ({ mutateAsync: vi.fn() }),
  useUpdateFolder: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../hooks/use-pages', () => ({
  usePageTree: () => ({ data: mocks.pages, isLoading: false, error: null }),
  useRecentPages: () => ({ data: [] }),
  useCreatePage: () => ({ mutateAsync: vi.fn() }),
  useUpdatePage: () => ({ mutateAsync: vi.fn() }),
  useImportMarkdown: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../hooks/use-shared-with-me', () => ({
  useSharedWithMeTree: () => ({ data: mocks.shared }),
}));
vi.mock('../../hooks/use-workspace', () => ({
  useWorkspaceMemberships: () => ({ data: mocks.memberships }),
  useLeaveWorkspace: () => ({ mutate: mocks.leaveWorkspace, isPending: false }),
}));
vi.mock('../../utils/entity-actions', () => ({
  useEntityDeletion: () => ({ handleDelete: vi.fn(), isPending: false }),
}));
vi.mock('./PageTreeRow', () => ({
  PageTreeRow: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { PageTree } from './PageTree';

function membership(ownerId: string, ownerName: string): WorkspaceMembership {
  return {
    ownerId,
    ownerName,
    role: 'viewer',
    joinedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('PageTree workspace navigation', () => {
  beforeEach(() => {
    mocks.pages = [];
    mocks.folders = [];
    mocks.shared = [];
    mocks.memberships = [];
    mocks.leaveWorkspace.mockReset();
  });

  it('groups visible workspace content under Shared With Me', () => {
    mocks.memberships = [membership('workspace-1', 'Alice')];
    mocks.pages = [
      createMockPageTreeNode({
        id: 'workspace-page',
        title: 'Workspace page',
        ownerId: 'workspace-1',
        workspaceAccess: true,
      }),
    ];

    render(<PageTree />);

    expect(screen.getByText('Shared With Me')).toBeInTheDocument();
    expect(screen.getByText("Alice's Workspace")).toBeInTheDocument();
    expect(screen.getByText('Workspace page')).toBeInTheDocument();
  });

  it('keeps an empty joined workspace visible with a leave action', () => {
    mocks.memberships = [membership('workspace-1', 'Alice')];

    render(<PageTree />);

    expect(screen.getByText('Shared With Me')).toBeInTheDocument();
    expect(screen.getByText("Alice's Workspace")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave Alice' })).toBeInTheDocument();
  });

  it('keeps a fully restricted workspace visible without exposing restricted names', () => {
    mocks.memberships = [membership('workspace-1', 'Alice')];
    mocks.pages = [
      createMockPageTreeNode({
        id: 'restricted-page',
        title: 'Secret roadmap',
        ownerId: 'workspace-1',
        workspaceAccess: false,
      }),
    ];
    mocks.folders = [
      createMockFolderTreeNode({
        id: 'restricted-folder',
        name: 'Secret folder',
        ownerId: 'workspace-1',
        workspaceAccess: false,
      }),
    ];

    render(<PageTree />);

    expect(screen.getByText("Alice's Workspace")).toBeInTheDocument();
    expect(screen.queryByText('Secret roadmap')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret folder')).not.toBeInTheDocument();
  });

  it('renders separate groups for multiple joined workspaces', () => {
    mocks.memberships = [membership('workspace-1', 'Alice'), membership('workspace-2', 'Bob')];

    render(<PageTree />);

    expect(screen.getByText("Alice's Workspace")).toBeInTheDocument();
    expect(screen.getByText("Bob's Workspace")).toBeInTheDocument();
  });

  it('leaves an empty workspace from its workspace-level control', async () => {
    const user = userEvent.setup();
    mocks.memberships = [membership('workspace-1', 'Alice')];
    render(<PageTree />);

    await user.click(screen.getByRole('button', { name: 'Leave Alice' }));

    expect(mocks.leaveWorkspace).toHaveBeenCalledWith({
      ownerId: 'workspace-1',
      memberId: 'current-user',
    });
  });
});
