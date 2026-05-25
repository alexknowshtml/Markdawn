import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isEditableFocused,
  keyboardRegistry,
  shouldIgnoreKeyboardEvent,
} from '../hooks/useKeyboardShortcuts';
import type { Priority } from '../hooks/useKeyboardShortcuts';

type Scope = string;

interface ShortcutDefinition {
  key: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: void allows simple arrow functions like () => fn()
  handler: (event: KeyboardEvent) => boolean | void;
  scope?: Scope;
  priority?: Priority;
  preventDefault?: boolean;
  description?: string;
  /** 'allow' — fires even when input/textarea/contenteditable is focused.
   *  'block' — suppressed when an editable element is focused. */
  whenInputFocused?: 'allow' | 'block';
}

interface ShortcutContextValue {
  activeScopes: Scope[];
  pushScope: (scopes: Scope[]) => void;
  popScope: () => void;
  getScopeBindings: (scope: Scope) => { key: string; description: string }[];
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

let hookIdCounter = 0;

export function KeyboardShortcutProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [scopeStack, setScopeStack] = useState<Scope[][]>([['*']]);
  const activeScopes = scopeStack[scopeStack.length - 1] ?? ['*'];

  useEffect(() => {
    keyboardRegistry.setActiveScopes(activeScopes);
  }, [activeScopes]);

  useEffect(() => {
    // Tracks events that the capture handler already prevented — the bubble
    // handler must still process them despite event.defaultPrevented being set.
    const browserIntercepted = new WeakSet<KeyboardEvent>();

    // Capture-phase handler for browser-conflicted shortcuts
    // (Ctrl+Shift+8 → Zen browser split pane). Browsers intercept these
    // before the bubble phase — calling preventDefault() in capture phase
    // tells the browser to treat the keypress as a web shortcut, not an
    // accelerator. The actual command dispatch happens in the bubble handler
    // so that normal shortcut logic (scope, priority, input-focus checks) still
    // applies.
    const captureHandler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = keyboardRegistry.normalizeKey(event);
      if (knownBrowserShortcuts.has(key)) {
        browserIntercepted.add(event);
        event.preventDefault();
      }
    };

    const handler = (event: KeyboardEvent) => {
      if (!browserIntercepted.has(event) && shouldIgnoreKeyboardEvent(event)) return;
      keyboardRegistry.dispatch(event, isEditableFocused());
    };

    // Zen browser emits the shifted character (event.key = '*') instead of the
    // raw digit ('8') when Shift is held. Register both forms for each shortcut
    // so the capture handler intercepts them regardless of browser behavior.
    const knownBrowserShortcuts = new Set<string>([
      'mod+shift+8',
      'mod+shift+*',
      'mod+shift+7',
      'mod+shift+&',
      'mod+shift+[',
      'mod+shift+{',
    ]);

    document.addEventListener('keydown', handler);
    window.addEventListener('keydown', captureHandler, { capture: true });
    return () => {
      document.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', captureHandler, { capture: true });
    };
  }, []);

  const pushScope = useCallback((scopes: Scope[]) => {
    setScopeStack((prev) => [...prev, scopes]);
  }, []);

  const popScope = useCallback(() => {
    setScopeStack((prev) => {
      // Never pop the last scope (always keep the default ['*'])
      if (prev.length <= 1) return prev;
      return prev.slice(0, -1);
    });
  }, []);

  const getScopeBindings = useCallback((scope: Scope) => {
    return keyboardRegistry
      .getBindingsForScope(scope)
      .filter((b) => b.description)
      .map((b) => ({ key: b.key, description: b.description }));
  }, []);

  const value = useMemo<ShortcutContextValue>(
    () => ({
      activeScopes,
      pushScope,
      popScope,
      getScopeBindings,
    }),
    [activeScopes, pushScope, popScope, getScopeBindings],
  );

  return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
}

/**
 * Register a keyboard shortcut binding.
 *
 * The binding is active for the lifetime of the component that calls this hook.
 * Handlers always receive the latest closure — no stale callback issues.
 */
export function useShortcut(def: ShortcutDefinition): void {
  const ctx = useContext(ShortcutContext);
  if (!ctx) {
    throw new Error('useShortcut must be used within a KeyboardShortcutProvider');
  }

  const idRef = useRef<string | null>(null);
  if (!idRef.current) {
    idRef.current = `hook-${++hookIdCounter}`;
  }

  const handlerRef = useRef(def.handler);
  handlerRef.current = def.handler;

  useEffect(() => {
    const id = idRef.current;
    if (!id) return;
    const normalizedKey = keyboardRegistry.patternToKey(def.key);

    const unregister = keyboardRegistry.register({
      id,
      key: normalizedKey,
      handler: (event) => {
        return handlerRef.current(event);
      },
      scope: def.scope ?? '*',
      priority: def.priority ?? 'normal',
      preventDefault: def.preventDefault ?? true,
      description: def.description ?? '',
      whenInputFocused: def.whenInputFocused ?? 'allow',
    });

    return unregister;
  }, [def.key, def.scope, def.priority, def.preventDefault, def.description, def.whenInputFocused]);
}

/**
 * Access the shortcut scope stack for dialog/modal management.
 *
 * Components should call `pushScope` when a dialog opens to restrict
 * which shortcuts fire, and `popScope` when it closes.
 */
export function useShortcutScope() {
  const ctx = useContext(ShortcutContext);
  if (!ctx) {
    throw new Error('useShortcutScope must be used within a KeyboardShortcutProvider');
  }
  return ctx;
}
