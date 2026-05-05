import { describe, expect, it, vi } from 'vitest';

const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock('../lib/auth-client', () => ({
  authClient: {
    useSession: mockUseSession,
  },
}));

import { useAuth } from './useAuth';

describe('useAuth', () => {
  it('returns the session from authClient.useSession', () => {
    const mockSession = {
      data: { user: { id: '1', email: 'a@b.com', name: 'Test' }, session: { id: 's1' } },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    };
    mockUseSession.mockReturnValue(mockSession);

    const result = useAuth();

    expect(result).toBe(mockSession);
    expect(mockUseSession).toHaveBeenCalled();
  });

  it('returns loading state when session is pending', () => {
    const mockSession = {
      data: null,
      isPending: true,
      error: null,
      refetch: vi.fn(),
    };
    mockUseSession.mockReturnValue(mockSession);

    const result = useAuth();

    expect(result.isPending).toBe(true);
    expect(result.data).toBeNull();
  });

  it('returns null user when unauthenticated', () => {
    const mockSession = {
      data: { user: null, session: null },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    };
    mockUseSession.mockReturnValue(mockSession);

    const result = useAuth();

    expect(result.data?.user).toBeNull();
    expect(result.isPending).toBe(false);
  });
});
