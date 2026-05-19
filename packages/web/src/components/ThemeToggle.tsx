import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { Tooltip } from './Tooltip';

function getModLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)) {
    return '⌘+Shift+D';
  }
  return 'Ctrl+Shift+D';
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const modLabel = getModLabel();

  const toggleTheme = () => {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  };

  const labels: Record<string, string> = {
    light: `Switch to dark theme (${modLabel})`,
    dark: `Switch to system theme (${modLabel})`,
    system: `Switch to light theme (${modLabel})`,
  };

  return (
    <Tooltip label={labels[theme] || 'Change theme'} position="right">
      <button
        type="button"
        aria-label="Toggle theme"
        onClick={toggleTheme}
        className="relative p-2 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-600 dark:text-zinc-300 overflow-hidden w-9 h-9 flex items-center justify-center cursor-pointer"
      >
        <div className="relative w-full h-full flex items-center justify-center">
          <div
            className={`absolute transition-all duration-300 ${theme === 'light' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 -rotate-90'}`}
          >
            <Sun size={18} />
          </div>
          <div
            className={`absolute transition-all duration-300 ${theme === 'dark' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 rotate-90'}`}
          >
            <Moon size={18} />
          </div>
          <div
            className={`absolute transition-all duration-300 ${theme === 'system' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 rotate-90'}`}
          >
            <Monitor size={18} />
          </div>
        </div>
      </button>
    </Tooltip>
  );
}
