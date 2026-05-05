import { screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { render } from './test-utils/render';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => children,
  };
});

vi.mock('./hooks/useAuth', () => ({
  useAuth: () => ({
    data: { user: null, session: null },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe('App', () => {
  it('renders the landing page at /', () => {
    render(<App />, { route: '/' });

    expect(screen.getByText('Welcome to Markdawn')).toBeInTheDocument();
  });

  it('renders login page at /login', () => {
    render(<App />, { route: '/login' });

    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('redirects protected route to login when unauthenticated', () => {
    render(<App />, { route: '/app' });

    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });
});
