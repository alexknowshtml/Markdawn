import { describe, expect, it, vi } from 'vitest';

vi.mock('./lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn().mockResolvedValue({ data: null, error: null }),
    signOut: vi.fn(),
  },
}));

describe('App', () => {
  it('renders without crashing', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { default: App } = await import('./App');

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(document.body).toBeTruthy();
  });
});
