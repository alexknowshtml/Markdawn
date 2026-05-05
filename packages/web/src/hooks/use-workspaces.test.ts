import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test-utils/wrapper';

vi.mock('../utils/toast', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

import { useWorkspace, useWorkspaces } from './use-workspaces';

describe('useWorkspaces', () => {
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

  it('fetches workspaces successfully', async () => {
    const mockData = [
      {
        id: 'ws-1',
        name: 'Test',
        slug: 'test',
        ownerId: null,
        isPersonal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const { result } = renderHook(() => useWorkspaces(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockData);
  });

  it('handles fetch error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    const { result } = renderHook(() => useWorkspaces(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useWorkspace', () => {
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

  it('does not fetch when slug is undefined', () => {
    renderHook(() => useWorkspace(undefined), { wrapper: createWrapper(queryClient) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches workspace by slug', async () => {
    const workspace = {
      id: 'ws-1',
      name: 'Test',
      slug: 'test',
      ownerId: null,
      isPersonal: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ workspace }),
    });

    const { result } = renderHook(() => useWorkspace('test'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(workspace);
  });

  it('handles non-wrapped response', async () => {
    const workspace = {
      id: 'ws-1',
      name: 'Test',
      slug: 'test',
      ownerId: null,
      isPersonal: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(workspace),
    });

    const { result } = renderHook(() => useWorkspace('test'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(workspace);
  });
});
