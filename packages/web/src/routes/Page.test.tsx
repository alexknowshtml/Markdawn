import { WebSocketStatus } from '@hocuspocus/provider';
import type { CapabilitySet } from '@markdawn/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsReadOnly } from '../contexts/EditorReadOnlyContext';
import { createTestQueryClient } from '../test-utils/render';

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const EDIT_CAPABILITIES: CapabilitySet = {
  canEdit: true,
  canComment: true,
  canDelete: false,
  canCopy: true,
};
const VIEW_CAPABILITIES: CapabilitySet = {
  canEdit: false,
  canComment: false,
  canDelete: false,
  canCopy: true,
};

const mocks = vi.hoisted(() => ({
  share: {
    isAnonymous: false,
    capabilities: {
      canEdit: true,
      canComment: true,
      canDelete: false,
      canCopy: true,
    },
    linkPermission: 'edit' as 'view' | 'edit' | null,
  },
  setLinkPermission: vi.fn(),
  setCapabilities: vi.fn(),
  loggerError: vi.fn(),
  snapshotPermission: 'edit' as 'view' | 'edit' | 'admin' | null,
  statusChange: null as ((status: WebSocketStatus) => void) | null,
  permissionSnapshot: null as
    | ((permission: 'view' | 'edit' | 'admin' | null, revision: string) => void)
    | null,
}));

vi.mock('../contexts/ShareContext', () => ({
  useShareContext: () => mocks.share,
  useSetLinkPermission: () => mocks.setLinkPermission,
  useSetCapabilities: () => mocks.setCapabilities,
}));
vi.mock('../hooks/use-pages', () => ({
  usePageTree: () => ({ data: [] }),
}));
vi.mock('../hooks/use-folders', () => ({
  useFolderTree: () => ({ data: [] }),
}));
vi.mock('../logger-init', () => ({
  getLogger: () => ({ error: mocks.loggerError }),
}));
vi.mock('../components/editor/BacklinksPanel', () => ({
  BacklinksPanel: () => <div data-testid="backlinks" />,
}));
vi.mock('../components/editor/Breadcrumbs', () => ({ Breadcrumbs: () => null }));
vi.mock('../components/editor/PageActions', () => ({
  PageActions: () => <div data-testid="page-actions" />,
}));
vi.mock('../components/editor/PageIcon', () => ({
  PageIcon: () => {
    const readOnly = useIsReadOnly();
    return <div data-testid="page-icon" data-read-only={String(readOnly)} />;
  },
}));
vi.mock('../components/editor/PageTitle', () => ({
  PageTitle: () => {
    const readOnly = useIsReadOnly();
    return <div data-testid="page-title" data-read-only={String(readOnly)} />;
  },
}));
vi.mock('../components/editor/PropertiesPanel', () => ({
  PropertiesPanel: () => {
    const readOnly = useIsReadOnly();
    return <div data-testid="properties" data-read-only={String(readOnly)} />;
  },
}));
vi.mock('../components/editor/MilkdownEditor', async () => {
  const { useEffect } = await import('react');
  return {
    MilkdownEditor: ({
      onPermissionSnapshot,
      onStatusChange,
    }: {
      onPermissionSnapshot: (
        permission: 'view' | 'edit' | 'admin' | null,
        revision: string,
      ) => void;
      onStatusChange: (status: WebSocketStatus) => void;
    }) => {
      const readOnly = useIsReadOnly();
      mocks.statusChange = onStatusChange;
      mocks.permissionSnapshot = onPermissionSnapshot;
      useEffect(() => {
        onPermissionSnapshot(mocks.snapshotPermission, '1');
      }, [onPermissionSnapshot]);
      return <div data-testid="page-body" data-read-only={String(readOnly)} />;
    },
  };
});
vi.mock('../components/editor/PageStatus', () => ({ PageStatus: () => null }));
vi.mock('../components/editor/TableOfContents', () => ({ TableOfContents: () => null }));
vi.mock('../components/ThemeToggle', () => ({ ThemeToggle: () => null }));

import Page from './Page';

function pageResponse(permission: 'view' | 'edit') {
  return {
    id: PAGE_ID,
    parentId: null,
    title: 'Test Page',
    icon: null,
    coverType: null,
    coverValue: null,
    position: 'a0',
    ydoc: null,
    properties: null,
    createdBy: 'owner-1',
    ownerId: 'owner-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userPermission: permission,
    capabilities: permission === 'edit' ? EDIT_CAPABILITIES : VIEW_CAPABILITIES,
  };
}

function renderPage() {
  const queryClient = createTestQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/app/test-page-${PAGE_ID}`]}>
        <Routes>
          <Route path="/app/:slugAndId" element={<Page />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...result };
}

function mockPageFetch(permission: 'view' | 'edit', accessResponses: Array<boolean> = [true]) {
  let accessIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/pages/${PAGE_ID}`) {
      return {
        ok: true,
        status: 200,
        json: async () => pageResponse(permission),
      } as Response;
    }
    if (url === `/api/pages/${PAGE_ID}/access`) {
      const ok = accessResponses[accessIndex] ?? accessResponses.at(-1) ?? false;
      accessIndex += 1;
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => ({ recordedLinkAccess: false }),
      } as Response;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function mockPageFetchSequence(statuses: number[]) {
  let pageIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/pages/${PAGE_ID}`) {
      const status = statuses[pageIndex] ?? statuses.at(-1) ?? 500;
      pageIndex += 1;
      return {
        ok: status === 200,
        status,
        json: async () =>
          status === 200 ? pageResponse('edit') : { message: `Request failed (${status})` },
      } as Response;
    }
    if (url === `/api/pages/${PAGE_ID}/access`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ recordedLinkAccess: false }),
      } as Response;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe('Page permission presentation', () => {
  beforeEach(() => {
    mocks.setLinkPermission.mockReset();
    mocks.setCapabilities.mockReset();
    mocks.share = {
      isAnonymous: false,
      capabilities: EDIT_CAPABILITIES,
      linkPermission: 'edit',
    };
    mocks.snapshotPermission = 'edit';
    mocks.statusChange = null;
    mocks.permissionSnapshot = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps body and title editable but metadata controls read-only for anonymous link editors', async () => {
    mocks.share = {
      isAnonymous: true,
      capabilities: EDIT_CAPABILITIES,
      linkPermission: 'edit',
    };
    vi.stubGlobal('fetch', mockPageFetch('edit'));
    await renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'false');
    });
    expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'true');
    expect(screen.queryByTestId('page-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backlinks')).not.toBeInTheDocument();
  });

  it('keeps the entire page read-only for anonymous viewers', async () => {
    mocks.share = {
      isAnonymous: true,
      capabilities: VIEW_CAPABILITIES,
      linkPermission: 'view',
    };
    mocks.snapshotPermission = 'view';
    vi.stubGlobal('fetch', mockPageFetch('view'));
    await renderPage();

    expect(await screen.findByTestId('page-body')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'true');
  });

  it('keeps all editor metadata controls editable for a signed-in editor', async () => {
    vi.stubGlobal('fetch', mockPageFetch('edit'));
    await renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'false');
    });
    expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'false');
    expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'false');
    expect(screen.getByTestId('page-actions')).toBeInTheDocument();
  });

  it('fails every editor surface closed on disconnect until a fresh snapshot arrives', async () => {
    vi.stubGlobal('fetch', mockPageFetch('edit'));
    await renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'false');
    });

    act(() => mocks.statusChange?.(WebSocketStatus.Disconnected));
    await waitFor(() => {
      expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'true');
      expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'true');
      expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'true');
      expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'true');
    });
    expect(screen.getByText('View only')).toBeInTheDocument();

    act(() => mocks.statusChange?.(WebSocketStatus.Connected));
    expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'true');

    act(() => mocks.permissionSnapshot?.('edit', '2'));
    await waitFor(() => {
      expect(screen.getByTestId('page-body')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-title')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('page-icon')).toHaveAttribute('data-read-only', 'false');
      expect(screen.getByTestId('properties')).toHaveAttribute('data-read-only', 'false');
    });
  });
});

describe('Page request errors', () => {
  beforeEach(() => {
    mocks.share = {
      isAnonymous: false,
      capabilities: EDIT_CAPABILITIES,
      linkPermission: 'edit',
    };
    mocks.snapshotPermission = 'edit';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('presents a terminal not-found state for a 404', async () => {
    vi.stubGlobal('fetch', mockPageFetchSequence([404]));
    await renderPage();

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('lets a transient server error be retried', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockPageFetchSequence([500, 200]));
    await renderPage();

    expect(
      await screen.findByRole('heading', { name: "Couldn't load this page" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('page-body')).toBeInTheDocument();
  });
});

describe('Page access recording retries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.loggerError.mockReset();
    mocks.share = {
      isAnonymous: false,
      capabilities: EDIT_CAPABILITIES,
      linkPermission: 'edit',
    };
    mocks.snapshotPermission = 'edit';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries once and succeeds without logging an error', async () => {
    const fetchMock = mockPageFetch('edit', [false, true]);
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    expect(await screen.findByTestId('page-body')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const accessCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `/api/pages/${PAGE_ID}/access`,
    );
    expect(accessCalls).toHaveLength(2);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('logs after the retry also fails', async () => {
    const fetchMock = mockPageFetch('edit', [false, false]);
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    expect(await screen.findByTestId('page-body')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    await waitFor(() => {
      expect(mocks.loggerError).toHaveBeenCalledWith(
        'Failed to record page access after retry',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });
  });

  it('cancels a scheduled retry when the page unmounts', async () => {
    const fetchMock = mockPageFetch('edit', [false, true]);
    vi.stubGlobal('fetch', fetchMock);
    const rendered = await renderPage();
    expect(await screen.findByTestId('page-body')).toBeInTheDocument();

    rendered.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const accessCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `/api/pages/${PAGE_ID}/access`,
    );
    expect(accessCalls).toHaveLength(1);
  });
});
