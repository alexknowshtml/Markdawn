import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { render } from '../test-utils/render';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('renders the sidebar', () => {
    render(<Sidebar />);

    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('shows collapsed state with correct data-testid', () => {
    render(<Sidebar collapsed={true} />);

    expect(screen.getByTestId('sidebar-collapsed')).toBeInTheDocument();
  });
});
