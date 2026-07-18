import { type QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useClipboard } from '../../contexts/ClipboardContext';
import { useIdentityNavigate } from '../../contexts/IdentityLifecycleContext';
import { useSelection } from '../../contexts/SelectionContext';
import { type Favorite, useToggleFavorite } from '../../hooks/use-favorites';
import { useCreatePage } from '../../hooks/use-pages';
import { useInviteToEntity } from '../../hooks/use-share';
import { createTestQueryClient } from '../../test-utils/render';
import {
  beginBulkRemoval,
  isBulkRemovalInProgress,
  resetBulkRemovalState,
} from '../../utils/bulkRemovalState';
import { consumeSelfLeave, markSelfLeave, resetSelfLeaveState } from '../../utils/leave-page';
import { showInfoToast, ToastProvider } from '../../utils/toast';

const mocks = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
  isPending: false,
  isRefetching: false,
  lateNavigation: vi.fn(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    data: mocks.userId ? { user: { id: mocks.userId } } : null,
    isPending: mocks.isPending,
    isRefetching: mocks.isRefetching,
  }),
}));

import { AuthIdentityBoundary } from './AuthIdentityBoundary';

const identityClients = new Map<string, QueryClient>();
let pendingFavoriteMutation: Promise<void> | null = null;
let pendingInviteMutation: Promise<unknown> | null = null;
let pendingCreateNavigation: Promise<void> | null = null;

function useRecordIdentityClient() {
  const queryClient = useQueryClient();
  const identity = mocks.userId ?? 'anonymous';
  useLayoutEffect(() => {
    identityClients.set(identity, queryClient);
  }, [identity, queryClient]);
  return queryClient;
}

function StatefulChild() {
  const queryClient = useRecordIdentityClient();
  const clipboard = useClipboard();
  const selection = useSelection();
  const [editorState, setEditorState] = useState('clean');
  const cachedOwner = queryClient.getQueryData<string>(['private-owner']) ?? 'empty';

  return (
    <div>
      <output data-testid="identity-state">
        {`${cachedOwner}:${clipboard.state.items.length}:${selection.selectedCount}:${editorState}`}
      </output>
      <button
        type="button"
        onClick={() => {
          queryClient.setQueryData(['private-owner'], mocks.userId);
          clipboard.copy([{ id: 'page-a', type: 'page' }]);
          selection.select({ id: 'page-a', type: 'page' });
          setEditorState('dirty');
        }}
      >
        Populate state
      </button>
    </div>
  );
}

const FAVORITE_A: Favorite = {
  entityType: 'page',
  entityId: 'page-a',
  pageId: 'page-a',
  title: 'A private favorite',
  icon: null,
  ownerId: 'user-a',
  createdAt: null,
};

const FAVORITE_B: Favorite = {
  entityType: 'page',
  entityId: 'page-b',
  pageId: 'page-b',
  title: 'B private favorite',
  icon: null,
  ownerId: 'user-b',
  createdAt: null,
};

function DeferredFavoriteMutationChild() {
  const queryClient = useRecordIdentityClient();
  const toggleFavorite = useToggleFavorite();

  return (
    <button
      type="button"
      onClick={() => {
        queryClient.setQueryData(['favorites'], [FAVORITE_A]);
        pendingFavoriteMutation = toggleFavorite.mutateAsync({
          pageId: 'page-a-new',
          title: 'A pending favorite',
          ownerId: 'user-a',
          isFavorite: false,
        });
      }}
    >
      Start favorite mutation
    </button>
  );
}

function DeferredInviteMutationChild() {
  useRecordIdentityClient();
  const invite = useInviteToEntity();

  return (
    <button
      type="button"
      onClick={() => {
        pendingInviteMutation = invite.mutateAsync(
          {
            entityType: 'page',
            entityId: 'page-a',
            email: 'recipient@example.com',
            permission: 'edit',
          },
          { onSuccess: () => mocks.lateNavigation('/app/a-private-page') },
        );
      }}
    >
      Start invite mutation
    </button>
  );
}

function DeferredCreateNavigationChild() {
  const createPage = useCreatePage();
  const navigate = useIdentityNavigate();

  return (
    <button
      type="button"
      onClick={() => {
        pendingCreateNavigation = (async () => {
          const page = await createPage.mutateAsync({});
          navigate(`/app/${page.title}-${page.id}`);
        })();
      }}
    >
      Create and open page
    </button>
  );
}

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}</output>;
}

describe('AuthIdentityBoundary', () => {
  beforeEach(() => {
    mocks.userId = 'user-a';
    mocks.isPending = false;
    mocks.isRefetching = false;
    identityClients.clear();
    pendingFavoriteMutation = null;
    pendingInviteMutation = null;
    pendingCreateNavigation = null;
    mocks.lateNavigation.mockReset();
    resetSelfLeaveState();
    resetBulkRemovalState();
  });

  it('clears identity-owned state before rendering a different user', async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    const removeAllRanges = vi.fn();
    const selectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges,
    } as unknown as Selection);
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <AuthIdentityBoundary>
          <StatefulChild />
        </AuthIdentityBoundary>
      </QueryClientProvider>,
    );

    await screen.findByRole('button', { name: 'Populate state' });
    const userAQueryClient = identityClients.get('user-a');
    expect(userAQueryClient).toBeDefined();
    const clearSpy = vi.spyOn(userAQueryClient as QueryClient, 'clear');
    removeAllRanges.mockClear();
    await user.click(screen.getByRole('button', { name: 'Populate state' }));
    expect(screen.getByTestId('identity-state')).toHaveTextContent('user-a:1:1:dirty');
    markSelfLeave('page-a');
    beginBulkRemoval();
    expect(isBulkRemovalInProgress()).toBe(true);

    mocks.userId = 'user-b';
    act(() =>
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <AuthIdentityBoundary>
            <StatefulChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('identity-state')).toHaveTextContent('empty:0:0:clean');
    });
    expect(identityClients.get('user-b')).not.toBe(userAQueryClient);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(consumeSelfLeave('page-a')).toBe(false);
    expect(isBulkRemovalInProgress()).toBe(false);
    selectionSpy.mockRestore();
  });

  it('unmounts identity-owned state while the session identity is being revalidated', async () => {
    const queryClient = createTestQueryClient();

    const rendered = render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <AuthIdentityBoundary>
            <StatefulChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>
      </ToastProvider>,
    );
    await screen.findByRole('button', { name: 'Populate state' });
    const userAQueryClient = identityClients.get('user-a');
    expect(userAQueryClient).toBeDefined();
    const clearSpy = vi.spyOn(userAQueryClient as QueryClient, 'clear');
    document.title = 'Secret Project | Markdawn';
    const favicon =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(document.createElement('link'));
    favicon.rel = 'icon';
    favicon.href = 'data:image/svg+xml,private';
    document.head.appendChild(favicon);
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = `${window.location.origin}/app/secret-project-page-a`;
    document.head.appendChild(canonical);
    act(() => showInfoToast('A private invitation'));
    expect(screen.getByText('A private invitation')).toBeInTheDocument();

    mocks.isRefetching = true;
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <AuthIdentityBoundary>
              <StatefulChild />
            </AuthIdentityBoundary>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );

    expect(screen.queryByRole('button', { name: 'Populate state' })).not.toBeInTheDocument();
    expect(screen.queryByText('A private invitation')).not.toBeInTheDocument();
    expect(document.title).toBe('Markdawn');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toContain(
      '/vite.svg',
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    mocks.userId = 'user-b';
    mocks.isRefetching = false;
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <AuthIdentityBoundary>
              <StatefulChild />
            </AuthIdentityBoundary>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('identity-state')).toHaveTextContent('empty:0:0:clean');
    });
    expect(identityClients.get('user-b')).not.toBe(userAQueryClient);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a retired identity when its optimistic mutation fails late', async () => {
    const user = userEvent.setup();
    let resolveFavoriteRequest: ((response: Response) => void) | undefined;
    const favoriteRequest = new Promise<Response>((resolve) => {
      resolveFavoriteRequest = resolve;
    });
    const fetchMock = vi.fn(() => favoriteRequest);
    vi.stubGlobal('fetch', fetchMock);
    const outerQueryClient = createTestQueryClient();

    const rendered = render(
      <ToastProvider>
        <QueryClientProvider client={outerQueryClient}>
          <AuthIdentityBoundary>
            <DeferredFavoriteMutationChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>
      </ToastProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Start favorite mutation' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const userAQueryClient = identityClients.get('user-a');
    expect(userAQueryClient).toBeDefined();
    expect(userAQueryClient?.getQueryData<Favorite[]>(['favorites'])).toEqual([
      expect.objectContaining({ title: 'A pending favorite' }),
      FAVORITE_A,
    ]);

    mocks.userId = 'user-b';
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={outerQueryClient}>
            <AuthIdentityBoundary>
              <DeferredFavoriteMutationChild />
            </AuthIdentityBoundary>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );

    await screen.findByRole('button', { name: 'Start favorite mutation' });
    const userBQueryClient = identityClients.get('user-b');
    expect(userBQueryClient).toBeDefined();
    expect(userBQueryClient).not.toBe(userAQueryClient);
    expect(userAQueryClient?.getQueryData(['favorites'])).toBeUndefined();
    userBQueryClient?.setQueryData(['favorites'], [FAVORITE_B]);

    await act(async () => {
      resolveFavoriteRequest?.({ ok: false } as Response);
      await favoriteRequest;
      await pendingFavoriteMutation?.catch(() => undefined);
    });

    expect(userAQueryClient?.getQueryData(['favorites'])).toBeUndefined();
    expect(userBQueryClient?.getQueryData<Favorite[]>(['favorites'])).toEqual([FAVORITE_B]);
    expect(screen.queryByText('Failed to update favorite')).not.toBeInTheDocument();
  });

  it('does not start a mutation request after async optimistic setup retires', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const outerQueryClient = createTestQueryClient();
    let finishCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });

    const rendered = render(
      <ToastProvider>
        <QueryClientProvider client={outerQueryClient}>
          <AuthIdentityBoundary>
            <DeferredFavoriteMutationChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>
      </ToastProvider>,
    );

    await screen.findByRole('button', { name: 'Start favorite mutation' });
    const userAQueryClient = identityClients.get('user-a');
    expect(userAQueryClient).toBeDefined();
    const cancelSpy = vi
      .spyOn(userAQueryClient as QueryClient, 'cancelQueries')
      .mockReturnValue(cancellation);
    await user.click(screen.getByRole('button', { name: 'Start favorite mutation' }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();

    mocks.userId = 'user-b';
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={outerQueryClient}>
            <AuthIdentityBoundary>
              <DeferredFavoriteMutationChild />
            </AuthIdentityBoundary>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );
    await screen.findByRole('button', { name: 'Start favorite mutation' });

    await act(async () => {
      finishCancellation?.();
      await cancellation;
      await pendingFavoriteMutation?.catch(() => undefined);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(userAQueryClient?.getQueryData(['favorites'])).toBeUndefined();
    expect(screen.queryByText('Failed to update favorite')).not.toBeInTheDocument();
  });

  it('skips hook and per-call callbacks when an invite succeeds after identity retirement', async () => {
    const user = userEvent.setup();
    let resolveInviteRequest: ((response: Response) => void) | undefined;
    const inviteRequest = new Promise<Response>((resolve) => {
      resolveInviteRequest = resolve;
    });
    const fetchMock = vi.fn(() => inviteRequest);
    vi.stubGlobal('fetch', fetchMock);
    const outerQueryClient = createTestQueryClient();

    const rendered = render(
      <ToastProvider>
        <QueryClientProvider client={outerQueryClient}>
          <AuthIdentityBoundary>
            <DeferredInviteMutationChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>
      </ToastProvider>,
    );

    const inviteButton = await screen.findByRole('button', { name: 'Start invite mutation' });
    await user.click(inviteButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const userAQueryClient = identityClients.get('user-a');
    expect(userAQueryClient).toBeDefined();
    const userAInvalidateSpy = vi.spyOn(userAQueryClient as QueryClient, 'invalidateQueries');

    mocks.userId = 'user-b';
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={outerQueryClient}>
            <AuthIdentityBoundary>
              <DeferredInviteMutationChild />
            </AuthIdentityBoundary>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );
    await screen.findByRole('button', { name: 'Start invite mutation' });
    const userBQueryClient = identityClients.get('user-b');
    expect(userBQueryClient).toBeDefined();
    const userBInvalidateSpy = vi.spyOn(userBQueryClient as QueryClient, 'invalidateQueries');
    userBQueryClient?.setQueryData(['shares', 'page', 'page-b'], { owner: 'user-b' });

    await act(async () => {
      resolveInviteRequest?.({
        ok: true,
        json: () => Promise.resolve({ message: 'A invitation sent' }),
      } as Response);
      await inviteRequest;
      await pendingInviteMutation;
    });

    expect(userAInvalidateSpy).not.toHaveBeenCalled();
    expect(userBInvalidateSpy).not.toHaveBeenCalled();
    expect(userBQueryClient?.getQueryData(['shares', 'page', 'page-b'])).toEqual({
      owner: 'user-b',
    });
    expect(screen.queryByText('A invitation sent')).not.toBeInTheDocument();
    expect(mocks.lateNavigation).not.toHaveBeenCalled();
  });

  it('preserves mutation callbacks while their identity remains active', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ message: 'Active invitation sent' }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const outerQueryClient = createTestQueryClient();

    render(
      <ToastProvider>
        <QueryClientProvider client={outerQueryClient}>
          <AuthIdentityBoundary>
            <DeferredInviteMutationChild />
          </AuthIdentityBoundary>
        </QueryClientProvider>
      </ToastProvider>,
    );

    const inviteButton = await screen.findByRole('button', { name: 'Start invite mutation' });
    const activeQueryClient = identityClients.get('user-a');
    expect(activeQueryClient).toBeDefined();
    const invalidateSpy = vi.spyOn(activeQueryClient as QueryClient, 'invalidateQueries');
    await user.click(inviteButton);
    await act(async () => {
      await pendingInviteMutation;
    });

    expect(await screen.findByText('Active invitation sent')).toBeInTheDocument();
    expect(mocks.lateNavigation).toHaveBeenCalledWith('/app/a-private-page');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shares', 'page', 'page-a'] });
  });

  it('blocks a deferred create continuation from navigating the next identity', async () => {
    const user = userEvent.setup();
    let resolveCreateRequest: ((response: Response) => void) | undefined;
    const createRequest = new Promise<Response>((resolve) => {
      resolveCreateRequest = resolve;
    });
    const fetchMock = vi.fn(() => createRequest);
    vi.stubGlobal('fetch', fetchMock);
    const outerQueryClient = createTestQueryClient();

    const rendered = render(
      <ToastProvider>
        <QueryClientProvider client={outerQueryClient}>
          <MemoryRouter initialEntries={['/app']}>
            <AuthIdentityBoundary>
              <DeferredCreateNavigationChild />
              <CurrentLocation />
            </AuthIdentityBoundary>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Create and open page' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    mocks.userId = 'user-b';
    act(() =>
      rendered.rerender(
        <ToastProvider>
          <QueryClientProvider client={outerQueryClient}>
            <MemoryRouter initialEntries={['/app']}>
              <AuthIdentityBoundary>
                <DeferredCreateNavigationChild />
                <CurrentLocation />
              </AuthIdentityBoundary>
            </MemoryRouter>
          </QueryClientProvider>
        </ToastProvider>,
      ),
    );
    await screen.findByRole('button', { name: 'Create and open page' });
    expect(screen.getByTestId('current-location')).toHaveTextContent('/app');

    await act(async () => {
      resolveCreateRequest?.({
        ok: true,
        json: () => Promise.resolve({ id: 'a-private-id', title: 'a-private-page' }),
      } as Response);
      await createRequest;
      await pendingCreateNavigation;
    });

    expect(screen.getByTestId('current-location')).toHaveTextContent('/app');
    expect(screen.queryByText('Page created')).not.toBeInTheDocument();
  });
});
