import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function BrokenComponent(): React.ReactElement {
  throw new Error('Test error');
}

function WorkingComponent(): React.ReactElement {
  return <div>Working</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.error).mockRestore();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <WorkingComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('renders error UI when child component throws', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/safely return home/i)).toBeInTheDocument();
  });

  it('renders Go Home button in error state', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );

    const button = screen.getByRole('button', { name: /go home/i });
    expect(button).toBeInTheDocument();
  });
});
