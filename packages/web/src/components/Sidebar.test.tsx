import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils/render';
import { Sidebar } from './Sidebar';

vi.mock('../hooks/use-workspaces', () => ({
  useWorkspaces: () => ({
    data: [
      {
        id: 'ws-1',
        name: 'Test WS',
        slug: 'test',
        ownerId: null,
        isPersonal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock('./sidebar/PageTree', () => ({
  PageTree: () => <div data-testid="page-tree">PageTree</div>,
}));

describe('Sidebar', () => {
  it('renders the sidebar', () => {
    render(<Sidebar />);

    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('shows collapsed state with correct data-testid', () => {
    render(<Sidebar collapsed={true} />);

    expect(screen.getByTestId('sidebar-collapsed')).toBeInTheDocument();
  });

  it('renders PageTree when workspaceSlug matches', () => {
    render(
      <Routes>
        <Route path="/app/:workspaceSlug" element={<Sidebar />} />
      </Routes>,
      { route: '/app/test' },
    );

    expect(screen.getByTestId('page-tree')).toBeInTheDocument();
  });

  it('shows empty state when no workspace matches', () => {
    render(<Sidebar />, { route: '/app/nonexistent' });

    expect(screen.getByText(/select a workspace/i)).toBeInTheDocument();
  });
});
