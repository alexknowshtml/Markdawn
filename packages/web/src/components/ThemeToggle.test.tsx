import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils/render';
import { ThemeToggle } from './ThemeToggle';

const mockSetTheme = vi.fn();

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: mockSetTheme,
    isDark: false,
  }),
}));

describe('ThemeToggle', () => {
  it('renders the theme toggle button with tooltip', () => {
    render(<ThemeToggle />);

    expect(screen.getByText('Switch to dark theme (Ctrl+Shift+D)')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('cycles from light to dark on click', () => {
    render(<ThemeToggle />);

    screen.getByRole('button').click();

    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });
});
