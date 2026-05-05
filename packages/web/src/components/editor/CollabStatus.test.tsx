import { WebSocketStatus } from '@hocuspocus/provider';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollabStatus } from './CollabStatus';

const mockAwareness = {
  getStates: vi.fn().mockReturnValue(
    new Map([
      ['u1', {}],
      ['u2', {}],
    ]),
  ),
  on: vi.fn(),
  off: vi.fn(),
};

function createMockProvider(status: WebSocketStatus) {
  return {
    status,
    awareness: mockAwareness,
  } as unknown as Parameters<typeof CollabStatus>[0]['provider'];
}

describe('CollabStatus', () => {
  it('renders nothing when provider is null', () => {
    const { container } = render(
      <CollabStatus provider={null} status={WebSocketStatus.Connecting} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows connecting status with amber dot', () => {
    const provider = createMockProvider(WebSocketStatus.Connecting);
    render(<CollabStatus provider={provider} status={WebSocketStatus.Connecting} />);

    expect(screen.getByText('Connecting')).toBeInTheDocument();
    const dot = document.querySelector('.bg-amber-500');
    expect(dot).toBeInTheDocument();
  });

  it('shows connected status with emerald dot', () => {
    const provider = createMockProvider(WebSocketStatus.Connected);
    render(<CollabStatus provider={provider} status={WebSocketStatus.Connected} />);

    expect(screen.getByText('Live')).toBeInTheDocument();
    const dot = document.querySelector('.bg-emerald-500');
    expect(dot).toBeInTheDocument();
  });

  it('shows disconnected status with rose dot', () => {
    const provider = createMockProvider(WebSocketStatus.Disconnected);
    render(<CollabStatus provider={provider} status={WebSocketStatus.Disconnected} />);

    expect(screen.getByText('Offline')).toBeInTheDocument();
    const dot = document.querySelector('.bg-rose-500');
    expect(dot).toBeInTheDocument();
  });

  it('registers awareness change listener', () => {
    const provider = createMockProvider(WebSocketStatus.Connected);
    render(<CollabStatus provider={provider} status={WebSocketStatus.Connected} />);

    expect(mockAwareness.on).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('cleans up awareness listener on unmount', () => {
    const provider = createMockProvider(WebSocketStatus.Connected);
    const { unmount } = render(
      <CollabStatus provider={provider} status={WebSocketStatus.Connected} />,
    );
    unmount();

    expect(mockAwareness.off).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
