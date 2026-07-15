import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorReadOnlyProvider } from '../../contexts/EditorReadOnlyContext';
import { createTestQueryClient } from '../../test-utils/render';

const mocks = vi.hoisted(() => ({
  isAnonymous: true,
  imageUploadFromSlash: null as (() => void) | null,
  showInfoToast: vi.fn(),
}));

vi.mock('@hocuspocus/provider', () => {
  class MockProvider {
    on = vi.fn();
    off = vi.fn();
    forceSync = vi.fn();
    destroy = vi.fn();
  }
  return {
    HocuspocusProvider: MockProvider,
    WebSocketStatus: {
      Connecting: 'connecting',
      Connected: 'connected',
      Disconnected: 'disconnected',
    },
  };
});
vi.mock('../../contexts/ShareContext', () => ({
  useShareContext: () => ({ isAnonymous: mocks.isAnonymous }),
  useSetLinkPermission: () => vi.fn(),
  useSetCapabilities: () => vi.fn(),
}));
vi.mock('../../contexts/KeyboardShortcutContext', () => ({
  useShortcut: vi.fn(),
}));
vi.mock('../../hooks/useAwareness', () => ({ useAwareness: vi.fn() }));
vi.mock('../../hooks/useFloatingToolbar', () => ({
  useFloatingToolbar: () => ({
    visible: false,
    position: null,
    linkEditorOpen: false,
    linkEditorPosition: null,
    linkEditorInitialUrl: '',
    mathEditorOpen: false,
    mathEditorPosition: null,
    mathEditorInitialLatex: '',
    mathEditorDisplayMode: false,
    closeLinkEditor: vi.fn(),
    closeMathEditor: vi.fn(),
  }),
}));
vi.mock('../../hooks/useMilkdown', () => ({
  useMilkdown: () => ({ setContainer: vi.fn(), editor: null }),
}));
vi.mock('../../hooks/useSlashMenu', () => ({
  useSlashMenu: (_editorRef: unknown, options: { handleImageUploadFromSlash: () => void }) => {
    mocks.imageUploadFromSlash = options.handleImageUploadFromSlash;
    return {
      slashMenuState: { isOpen: false, query: '', position: null, range: null },
      slashCommands: [],
      handleSlashMenuSuggest: vi.fn(),
      closeSlashMenu: vi.fn(),
    };
  },
}));
vi.mock('../../hooks/useWikiLinkSuggestions', () => ({
  useWikiLinkSuggestions: () => ({
    suggestions: { isOpen: false, query: '', position: null, isLoading: false },
    allPages: [],
    handleWikiLinkSuggest: vi.fn(),
    handleWikiLinkSelect: vi.fn(),
    handleAddPage: vi.fn(),
    canAddPage: false,
    closeSuggestions: vi.fn(),
  }),
}));
vi.mock('../../logger-init', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../utils/toast', () => ({
  showInfoToast: mocks.showInfoToast,
}));
vi.mock('./FloatingToolbar', () => ({ FloatingToolbar: () => null }));
vi.mock('./SlashMenu', () => ({ SlashMenu: () => null }));
vi.mock('./WikiLinkSuggestions', () => ({ WikiLinkSuggestions: () => null }));

import { MilkdownEditor } from './MilkdownEditor';

function renderEditor() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EditorReadOnlyProvider readOnly={false}>
          <MilkdownEditor pageId="page-1" />
        </EditorReadOnlyProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MilkdownEditor anonymous uploads', () => {
  beforeEach(() => {
    mocks.isAnonymous = true;
    mocks.imageUploadFromSlash = null;
    mocks.showInfoToast.mockReset();
  });

  it('explains that image uploads require sign-in without opening a file picker', () => {
    const createElementSpy = vi.spyOn(document, 'createElement');
    renderEditor();

    expect(mocks.imageUploadFromSlash).not.toBeNull();
    act(() => {
      mocks.imageUploadFromSlash?.();
    });

    expect(mocks.showInfoToast).toHaveBeenCalledWith('Sign in to upload images');
    expect(createElementSpy).not.toHaveBeenCalledWith('input');
  });
});
