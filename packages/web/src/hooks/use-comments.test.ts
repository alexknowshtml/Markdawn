import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import {
  useAddReply,
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment,
} from './use-comments';

describe('useComments', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('does not fetch when pageId is undefined', () => {
    renderHook(() => useComments(undefined), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches comments successfully', async () => {
    const comments = [
      {
        id: 'c1',
        pageId: 'p1',
        userId: 'u1',
        content: 'Test comment',
        anchorBlockId: null,
        resolved: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ];
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(comments) });

    const { result } = renderHook(() => useComments('p1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(comments);
    expect(fetchMock).toHaveBeenCalledWith('/api/pages/p1/comments');
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useComments('p1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useCreateComment', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('creates a comment', async () => {
    const comment = { id: 'c-new', pageId: 'p1', content: 'New comment' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(comment) });

    const { result } = renderHook(() => useCreateComment('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ content: 'New comment' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'New comment', anchorBlockId: undefined }),
      }),
    );
  });

  it('creates comment with anchor block', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'c-new' }) });

    const { result } = renderHook(() => useCreateComment('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ content: 'Anchor comment', anchorBlockId: 'block-1' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.anchorBlockId).toBe('block-1');
  });

  it('throws when pageId is missing', async () => {
    const { result } = renderHook(() => useCreateComment(undefined), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ content: 'Test' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('pageId is required');
  });
});

describe('useAddReply', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('adds a reply to a comment', async () => {
    const reply = { id: 'r1', commentId: 'c1', content: 'Reply' };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(reply) });

    const { result } = renderHook(() => useAddReply('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ commentId: 'c1', content: 'Reply' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/comments/c1/replies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'Reply' }),
      }),
    );
  });
});

describe('useUpdateComment', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('updates comment content', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'c1' }) });

    const { result } = renderHook(() => useUpdateComment('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ commentId: 'c1', updates: { content: 'Updated' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/comments/c1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ content: 'Updated' }),
      }),
    );
  });

  it('resolves a comment', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'c1', resolved: true }),
    });

    const { result } = renderHook(() => useUpdateComment('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ commentId: 'c1', updates: { resolved: true } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.resolved).toBe(true);
  });
});

describe('useDeleteComment', () => {
  let queryClient: ReturnType<typeof createTestQueryClient>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('deletes a comment', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useDeleteComment('p1'), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('c1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pages/p1/comments/c1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
