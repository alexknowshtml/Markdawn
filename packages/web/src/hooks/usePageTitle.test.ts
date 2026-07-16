import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
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

  it('does not save when pageId is missing', async () => {
    renderHook(() => usePageTitle(undefined, 'Original'), { wrapper: createWrapper(queryClient) });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
