import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createIdentityLifecycle,
  IdentityLifecycleProvider,
} from '../contexts/IdentityLifecycleContext';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

import { usePageTitle } from './usePageTitle';

describe('usePageTitle', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('defaults to "Untitled" when no initialTitle', () => {
    const { result } = renderHook(() => usePageTitle('p1'), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.title).toBe('Untitled');
  });

  it('uses initialTitle when provided', () => {
    const { result } = renderHook(() => usePageTitle('p1', 'My Document'), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.title).toBe('My Document');
  });

  it('normalizes blank title to "Untitled"', () => {
    const { result } = renderHook(() => usePageTitle('p1', '   '), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.title).toBe('Untitled');
  });

  it('setTitle updates local state immediately', () => {
    const { result } = renderHook(() => usePageTitle('p1', 'Original'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setTitle('Updated Title');
    });

    expect(result.current.title).toBe('Updated Title');
  });

  it('does not overwrite an in-progress title edit when page data refetches', () => {
    const { result, rerender } = renderHook(
      ({ initialTitle }) => usePageTitle('p1', initialTitle),
      {
        initialProps: { initialTitle: 'Original' },
        wrapper: createWrapper(queryClient),
      },
    );

    act(() => result.current.setTitle('Typing locally'));
    rerender({ initialTitle: 'Original from refetch' });

    expect(result.current.title).toBe('Typing locally');
  });

  it('cancels previous debounce on rapid changes', async () => {
    const { result } = renderHook(() => usePageTitle('p1', 'Original'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.commitTitle('First');
      result.current.commitTitle('Second');
      result.current.commitTitle('Final');
    });

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/pages/p1',
          expect.objectContaining({
            body: JSON.stringify({ title: 'Final' }),
          }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('persists anonymous titles through Yjs and the public-link endpoint', async () => {
    const ydoc = new Y.Doc();
    ydoc.getText('title').insert(0, 'Original');
    const { result } = renderHook(
      () => usePageTitle('p1', 'Original', ydoc, { usePublicEndpoint: true }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => result.current.commitTitle('Anonymous title'));

    expect(ydoc.getText('title').toString()).toBe('Anonymous title');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/pages/p1/title',
        expect.objectContaining({ body: JSON.stringify({ title: 'Anonymous title' }) }),
      );
    });
  });

  it('falls back to the public endpoint while anonymous session state is settling', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const { result } = renderHook(() => usePageTitle('p1', 'Original'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => result.current.commitTitle('Early anonymous title'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/pages/p1/title',
        expect.objectContaining({ body: JSON.stringify({ title: 'Early anonymous title' }) }),
      );
    });
  });

  it('does not retry a title request after its identity retires', async () => {
    let resolveFirstRequest: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFirstRequest = resolve;
      }),
    );
    const lifecycle = createIdentityLifecycle();
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(IdentityLifecycleProvider, { lifecycle }, children),
      );
    const { result } = renderHook(() => usePageTitle('p1', 'Original'), { wrapper });

    act(() => result.current.commitTitle('A private title'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    lifecycle.retire();
    await act(async () => {
      resolveFirstRequest?.({ ok: false, status: 401 } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not save when pageId is missing', async () => {
    renderHook(() => usePageTitle(undefined, 'Original'), { wrapper: createWrapper(queryClient) });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
