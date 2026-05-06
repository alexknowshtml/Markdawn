import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseParams = vi.fn();
const mockUseTheme = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
}));

vi.mock('./useTheme', () => ({
  useTheme: () => mockUseTheme(),
}));

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  const toggleSidebar = vi.fn();
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ workspaceSlug: 'test-workspace' });
    mockUseTheme.mockReturnValue({ setTheme, isDark: false, theme: 'light' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderShortcuts(options?: { workspaceSlug?: string; isDark?: boolean }) {
    if (options) {
      mockUseParams.mockReturnValue({ workspaceSlug: options.workspaceSlug });
      mockUseTheme.mockReturnValue({
        setTheme,
        isDark: options.isDark ?? false,
        theme: options.isDark ? 'dark' : 'light',
      });
    }
    return renderHook(() => useKeyboardShortcuts({ toggleSidebar }));
  }

  it('dispatches create-note event on Ctrl+N', () => {
    const handler = vi.fn();
    window.addEventListener('markdawn:create-note', handler);

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail.workspaceSlug).toBe('test-workspace');

    window.removeEventListener('markdawn:create-note', handler);
  });

  it('dispatches create-folder event on Ctrl+Shift+N', () => {
    const handler = vi.fn();
    window.addEventListener('markdawn:create-folder', handler);

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener('markdawn:create-folder', handler);
  });

  it('calls toggleSidebar on Ctrl+/', () => {
    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('toggles theme on Ctrl+Shift+D', () => {
    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('toggles theme to light when currently dark', () => {
    mockUseTheme.mockReturnValue({ setTheme, isDark: true, theme: 'dark' });

    renderShortcuts({ isDark: true });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, shiftKey: true, bubbles: true }),
    );

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('does not dispatch create-note when no workspaceSlug', () => {
    const handler = vi.fn();
    window.addEventListener('markdawn:create-note', handler);

    renderShortcuts({});

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(handler).not.toHaveBeenCalled();

    window.removeEventListener('markdawn:create-note', handler);
  });

  it('ignores shortcuts when input element is focused', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(toggleSidebar).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('ignores shortcuts when textarea is focused', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(toggleSidebar).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('ignores shortcuts when contenteditable is focused', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    div.focus();

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(toggleSidebar).not.toHaveBeenCalled();

    document.body.removeChild(div);
  });

  it('cleans up event listener on unmount', () => {
    const { unmount } = renderShortcuts();
    unmount();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it('supports Meta key (Mac)', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });

    renderShortcuts();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }),
    );

    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    if (originalPlatform) {
      Object.defineProperty(navigator, 'platform', originalPlatform);
    }
  });
});
