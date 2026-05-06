import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('cancels previous debounce on rapid changes', async () => {
    const { result } = renderHook(() => usePageTitle('p1', 'Original'), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.setTitle('First');
      result.current.setTitle('Second');
      result.current.setTitle('Final');
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

  it('does not save when pageId is missing', async () => {
    renderHook(() => usePageTitle(undefined, 'Original'), { wrapper: createWrapper(queryClient) });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
