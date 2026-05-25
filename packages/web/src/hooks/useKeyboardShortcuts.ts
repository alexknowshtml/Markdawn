export type Priority = 'high' | 'normal' | 'low';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export interface HotkeyBinding {
  id: string;
  key: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: void allows simple arrow functions like () => fn()
  handler: (event: KeyboardEvent) => boolean | void;
  scope: string;
  priority: Priority;
  preventDefault: boolean;
  description: string;
  /** 'allow' — fires even when an input/textarea/contenteditable is focused.
   *  'block' — suppressed when an editable element is focused. */
  whenInputFocused: 'allow' | 'block';
}

let bindingCounter = 0;

/**
 * Module-level keyboard shortcut registry (zero React dependencies).
 *
 * Manages all keyboard bindings in a single place with priority ordering,
 * scope filtering, and input-focus awareness. The React layer wraps this
 * and provides component-lifecycle-safe registration.
 */
export class KeyboardRegistry {
  private bindings: HotkeyBinding[] = [];
  private activeScopes = new Set<string>(['*']);

  /**
   * Register a keyboard binding. Returns an unregister function.
   */
  register(binding: Omit<HotkeyBinding, 'id'> & { id?: string }): () => void {
    const id = binding.id ?? `kb-${++bindingCounter}`;
    const entry: HotkeyBinding = { ...binding, id };
    this.bindings.push(entry);
    this.bindings.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return () => {
      this.bindings = this.bindings.filter((b) => b.id !== id);
    };
  }

  /**
   * Dispatch a KeyboardEvent through the registry.
   * Returns true if a binding handled the event.
   */
  dispatch(event: KeyboardEvent, isEditableFocused: boolean): boolean {
    const key = this.normalizeKey(event);

    for (const b of this.bindings) {
      if (b.key !== key) continue;

      if (b.whenInputFocused === 'block' && isEditableFocused) continue;
      if (!this.activeScopes.has(b.scope) && !this.activeScopes.has('*')) continue;

      try {
        const handled = b.handler(event);
        if (handled === false) continue; // Handler returned false — try next binding
        if (b.preventDefault) event.preventDefault();
        return true;
      } catch {}
    }
    return false;
  }

  /**
   * Set the currently active scopes. Only bindings matching an active scope
   * will fire. The special scope '*' matches all bindings.
   */
  setActiveScopes(scopes: string[]): void {
    this.activeScopes = new Set(scopes);
  }

  getActiveScopes(): string[] {
    return Array.from(this.activeScopes);
  }

  /** Get all bindings for a given scope (for display in menus). */
  getBindingsForScope(scope: string): HotkeyBinding[] {
    return this.bindings.filter((b) => b.scope === scope || b.scope === '*');
  }

  /** Clear all registered bindings (for test isolation). */
  clearAll(): void {
    this.bindings = [];
    this.activeScopes = new Set(['*']);
    bindingCounter = 0;
  }

  normalizeKey(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.metaKey || event.ctrlKey) parts.push('mod');
    if (event.altKey && event.key !== 'Alt' && event.key !== 'AltGraph') parts.push('alt');
    if (event.shiftKey && event.key !== 'Shift') parts.push('shift');
    // Sort modifiers deterministically so key order never breaks matching
    parts.sort();

    const key = event.key;
    if (['Control', 'Meta', 'Alt', 'AltGraph', 'Shift', 'OS'].includes(key)) {
      return parts.join('+') || key.toLowerCase();
    }

    if (key === ' ') return [...parts, 'space'].join('+');

    return [...parts, key.toLowerCase()].join('+');
  }

  /** Convert a user-facing pattern like "mod+shift+n" to normalized form. */
  patternToKey(pattern: string): string {
    const parts = pattern
      .toLowerCase()
      .replace(/\bctrl\b/g, 'mod')
      .replace(/\bcmd\b/g, 'mod')
      .replace(/\bcommand\b/g, 'mod')
      .replace(/\boption\b/g, 'alt')
      .split('+');
    // Sort modifier segments so registration order never matters
    const key = parts.pop() ?? '';
    parts.sort();
    parts.push(key);
    return parts.join('+');
  }
}

/** App-wide singleton registry. */
export const keyboardRegistry = new KeyboardRegistry();

/**
 * Determine if a keyboard event is clearly text input that should
 * NOT trigger global shortcuts.
 *
 * The gate is intentionally permissive: it only filters out plain
 * keypresses (no modifier) in editable areas. Modifier combos pass
 * through — the registry's per-binding `whenInputFocused` setting
 * handles finer-grained filtering.
 */
export function shouldIgnoreKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;

  if (event.key === 'Escape') return false;

  const tagName = target.tagName;
  const isEditable =
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.contentEditable === 'true';

  if (!isEditable) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;

  return true;
}

/**
 * Check whether the currently focused DOM element is an editable input
 * (input, textarea, select, or contenteditable). Used by the registry
 * to filter per-binding `whenInputFocused` settings.
 */
export function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tagName = el.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    (el instanceof HTMLElement && el.contentEditable === 'true')
  );
}
