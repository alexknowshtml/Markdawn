import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceMetadata } from './useWorkspaceMetadata';

vi.mock('./use-pages', () => ({
  usePages: vi.fn(),
}));

import type { Page } from '@markdawn/shared';
import { usePages } from './use-pages';

const mockUsePages = vi.mocked(usePages);

function createMockPage(properties: Record<string, unknown> | null): Page {
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    parentId: null,
    title: 'Test',
    icon: null,
    coverType: null,
    coverValue: null,
    position: 'a',
    ydoc: null,
    properties,
    createdBy: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };
}

function createUsePagesReturn(data: Page[]): ReturnType<typeof usePages> {
  return {
    data,
    dataUpdatedAt: Date.now(),
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: 'idle',
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    promise: Promise.resolve(data),
    status: 'success',
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePages>;
}

describe('useWorkspaceMetadata', () => {
  it('returns default keys when no pages exist', () => {
    mockUsePages.mockReturnValue(createUsePagesReturn([]));

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allKeys).toEqual(['author', 'created', 'date', 'tags', 'updated', 'url']);
    expect(result.current.allTags).toEqual([]);
  });

  it('extracts property keys from pages', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([
        createMockPage({ status: 'active', priority: 'high' }),
        createMockPage({ status: 'archived', owner: 'alice' }),
      ]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allKeys).toContain('status');
    expect(result.current.allKeys).toContain('priority');
    expect(result.current.allKeys).toContain('owner');
  });

  it('collects tag values from tags array field', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([
        createMockPage({ tags: ['frontend', 'ui', 'react'] }),
        createMockPage({ tags: ['backend', 'api'] }),
      ]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allTags).toEqual(['api', 'backend', 'frontend', 'react', 'ui']);
  });

  it('collects tag values from tag string field', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([createMockPage({ tag: 'important' }), createMockPage({ tag: 'wip' })]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allTags).toEqual(['important', 'wip']);
  });

  it('ignores empty and whitespace-only tag values', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([
        createMockPage({
          tags: ['valid', '', '  ', null],
        }),
      ]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allTags).toEqual(['valid']);
  });

  it('always includes default keys alongside extracted keys', () => {
    mockUsePages.mockReturnValue(createUsePagesReturn([createMockPage({ customKey: 'value' })]));

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allKeys).toContain('customKey');
    expect(result.current.allKeys).toContain('date');
    expect(result.current.allKeys).toContain('author');
    expect(result.current.allKeys).toContain('url');
  });

  it('sorts keys alphabetically', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([createMockPage({ zed: '1', alpha: '2', beta: '3' })]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    const keys = result.current.allKeys;
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]?.localeCompare(keys[i] ?? '')).toBeLessThanOrEqual(0);
    }
  });

  it('sorts tags alphabetically', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([createMockPage({ tags: ['zebra', 'apple', 'banana'] })]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allTags).toEqual(['apple', 'banana', 'zebra']);
  });

  it('handles pages with null or undefined properties', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([createMockPage(null), createMockPage({ key: 'val' })]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allKeys).toContain('key');
  });

  it('handles pages with non-object properties', () => {
    mockUsePages.mockReturnValue(
      createUsePagesReturn([createMockPage('not-an-object' as unknown as Record<string, unknown>)]),
    );

    const { result } = renderHook(() => useWorkspaceMetadata('ws-1'));

    expect(result.current.allKeys).toEqual(['author', 'created', 'date', 'tags', 'updated', 'url']);
    expect(result.current.allTags).toEqual([]);
  });
});
