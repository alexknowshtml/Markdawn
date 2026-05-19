import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KeyboardShortcutProvider,
  useShortcut,
  useShortcutScope,
} from '../contexts/KeyboardShortcutContext';
import { keyboardRegistry, shouldIgnoreKeyboardEvent } from './useKeyboardShortcuts';

// ---------------------------------------------------------------------------
// Unit tests: KeyboardRegistry
// ---------------------------------------------------------------------------

describe('KeyboardRegistry', () => {
  beforeEach(() => {
    keyboardRegistry.clearAll();
  });

  it('dispatches to the correct binding by key', () => {
    const handler = vi.fn();
    const unreg = keyboardRegistry.register({
      id: 'test-1',
      key: 'mod+/',
      handler,
      scope: '*',
      priority: 'normal',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });

    const event = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true });
    const handled = keyboardRegistry.dispatch(event, false);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    unreg();
  });

  it('does not dispatch when scopes do not match', () => {
    keyboardRegistry.setActiveScopes(['modal']);
    const handler = vi.fn();
    const unreg = keyboardRegistry.register({
      id: 'test-2',
      key: 'mod+n',
      handler,
      scope: 'global',
      priority: 'normal',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });

    const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true });
    const handled = keyboardRegistry.dispatch(event, false);

    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    unreg();
  });

  it('blocks binding when input is focused and whenInputFocused is block', () => {
    const handler = vi.fn();
    const unreg = keyboardRegistry.register({
      id: 'test-3',
      key: 'mod+n',
      handler,
      scope: '*',
      priority: 'normal',
      preventDefault: true,
      description: '',
      whenInputFocused: 'block',
    });

    const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true });
    const handled = keyboardRegistry.dispatch(event, true);

    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    unreg();
  });

  it('allows binding when input is focused and whenInputFocused is allow', () => {
    const handler = vi.fn();
    const unreg = keyboardRegistry.register({
      id: 'test-4',
      key: 'mod+/',
      handler,
      scope: '*',
      priority: 'normal',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });

    const event = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true });
    const handled = keyboardRegistry.dispatch(event, true);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    unreg();
  });

  it('respects priority ordering', () => {
    const lowHandler = vi.fn();
    const highHandler = vi.fn();

    keyboardRegistry.register({
      id: 'test-low',
      key: 'mod+k',
      handler: lowHandler,
      scope: '*',
      priority: 'low',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });
    keyboardRegistry.register({
      id: 'test-high',
      key: 'mod+k',
      handler: highHandler,
      scope: '*',
      priority: 'high',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });

    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true });
    keyboardRegistry.dispatch(event, false);

    expect(highHandler).toHaveBeenCalledTimes(1);
    expect(lowHandler).not.toHaveBeenCalled();
  });

  it('normalizes key patterns correctly', () => {
    expect(keyboardRegistry.patternToKey('mod+/')).toBe('mod+/');
    expect(keyboardRegistry.patternToKey('Ctrl+N')).toBe('mod+n');
    expect(keyboardRegistry.patternToKey('Cmd+Shift+K')).toBe('mod+shift+k');
    expect(keyboardRegistry.patternToKey('mod+shift+d')).toBe('mod+shift+d');
    expect(keyboardRegistry.patternToKey('Escape')).toBe('escape');
  });

  it('cleans up bindings via unregister function', () => {
    const handler = vi.fn();
    const unreg = keyboardRegistry.register({
      id: 'test-cleanup',
      key: 'mod+/',
      handler,
      scope: '*',
      priority: 'normal',
      preventDefault: true,
      description: '',
      whenInputFocused: 'allow',
    });
    unreg();

    const event = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true });
    const handled = keyboardRegistry.dispatch(event, false);

    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: shouldIgnoreKeyboardEvent
// ---------------------------------------------------------------------------

describe('shouldIgnoreKeyboardEvent', () => {
  it('returns true when defaultPrevented', () => {
    const event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true });
    vi.spyOn(event, 'defaultPrevented', 'get').mockReturnValue(true);
    expect(shouldIgnoreKeyboardEvent(event)).toBe(true);
  });

  it('returns false for Escape always', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'target', {
      value: document.createElement('textarea'),
    });
    expect(shouldIgnoreKeyboardEvent(event)).toBe(false);
  });

  it('returns false for modifier combos in textarea (fixes #64)', () => {
    const textarea = document.createElement('textarea');
    const event = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true });
    Object.defineProperty(event, 'target', { value: textarea });
    expect(shouldIgnoreKeyboardEvent(event)).toBe(false);
  });

  it('returns false for modifier combos in contenteditable', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    const event = new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true });
    Object.defineProperty(event, 'target', { value: div });
    expect(shouldIgnoreKeyboardEvent(event)).toBe(false);
  });

  it('returns true for plain key in textarea (text input)', () => {
    const textarea = document.createElement('textarea');
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
    Object.defineProperty(event, 'target', { value: textarea });
    expect(shouldIgnoreKeyboardEvent(event)).toBe(true);
  });

  it('returns false for non-editable elements', () => {
    const div = document.createElement('div');
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
    Object.defineProperty(event, 'target', { value: div });
    expect(shouldIgnoreKeyboardEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: useShortcut + KeyboardShortcutProvider
// ---------------------------------------------------------------------------

import type React from 'react';
import { createElement } from 'react';

function createWrapper() {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(KeyboardShortcutProvider, null, children);
  };
}

describe('useShortcut', () => {
  beforeEach(() => {
    keyboardRegistry.clearAll();
  });

  it('fires handler on matching keydown', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+/', handler, description: 'Toggle sidebar' }), {
      wrapper: createWrapper(),
    });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports Meta key (Mac)', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+/', handler, description: 'Toggle sidebar' }), {
      wrapper: createWrapper(),
    });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not fire for wrong key', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+/', handler }), { wrapper: createWrapper() });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('uses latest handler closure', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const { rerender } = renderHook(({ handler }) => useShortcut({ key: 'mod+n', handler }), {
      wrapper: createWrapper(),
      initialProps: { handler: handler1 },
    });

    rerender({ handler: handler2 });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useShortcut({ key: 'mod+/', handler }), {
      wrapper: createWrapper(),
    });
    unmount();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('useShortcut + whenInputFocused', () => {
  beforeEach(() => {
    keyboardRegistry.clearAll();
  });

  it('blocks shortcut when input is focused and whenInputFocused is block (Ctrl+N in input)', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+n', handler, whenInputFocused: 'block' }), {
      wrapper: createWrapper(),
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }),
    );

    expect(handler).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('fires shortcut when textarea is focused and whenInputFocused is allow (Ctrl+/ in textarea, fixes #64)', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+/', handler, whenInputFocused: 'allow' }), {
      wrapper: createWrapper(),
    });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    document.body.removeChild(textarea);
  });

  it('fires shortcut when contenteditable is focused and whenInputFocused is allow', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut({ key: 'mod+/', handler, whenInputFocused: 'allow' }), {
      wrapper: createWrapper(),
    });

    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);
    div.focus();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    document.body.removeChild(div);
  });
});

describe('useShortcutScope', () => {
  beforeEach(() => {
    keyboardRegistry.clearAll();
  });

  it('throws when used outside provider', () => {
    expect(() => renderHook(() => useShortcutScope())).toThrow(
      'useShortcutScope must be used within a KeyboardShortcutProvider',
    );
  });
});
