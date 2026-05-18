import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'markdawn-theme';

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem(THEME_KEY) as Theme;
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function readIsDark(theme: Theme): boolean {
  if (typeof window === 'undefined') return false;
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return theme === 'dark';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const dark = readIsDark(theme);
  if (dark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  localStorage.setItem(THEME_KEY, theme);
}

// Module-level event bus so every useTheme consumer stays in sync
const themeListeners = new Set<() => void>();
function notifyThemeListeners() {
  for (const fn of themeListeners) fn();
}

function subscribeToThemeChanges(onChange: () => void): () => void {
  themeListeners.add(onChange);
  return () => {
    themeListeners.delete(onChange);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeToThemeChanges, readTheme);

  const setTheme = useCallback((newTheme: Theme) => {
    applyTheme(newTheme);
    notifyThemeListeners();
  }, []);

  const isDark = readIsDark(theme);

  // Re-evaluate when the OS preference changes (only matters for 'system' theme)
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system');
        notifyThemeListeners();
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  return { theme, setTheme, isDark };
}
