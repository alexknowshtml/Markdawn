import { Sun, Moon, Monitor, Github } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

const GITHUB_REPO = "https://github.com/atharva-again/Markdawn";

export function HeaderActions() {
  const { theme, setTheme } = useTheme();

  const toggleTheme = () => {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  };

  return (
    <div className="flex items-center gap-1 p-1 rounded-full">
      <button
        onClick={toggleTheme}
        className="relative p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors text-zinc-600 dark:text-zinc-300 overflow-hidden w-7 h-7 flex items-center justify-center cursor-pointer"
        title={`Theme: ${theme}`}
      >
        <div className="relative w-full h-full flex items-center justify-center">
          <div className={`absolute transition-all duration-300 ${theme === 'light' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 -rotate-90'}`}>
            <Sun size={14} />
          </div>
          <div className={`absolute transition-all duration-300 ${theme === 'dark' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 rotate-90'}`}>
            <Moon size={14} />
          </div>
          <div className={`absolute transition-all duration-300 ${theme === 'system' ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 rotate-90'}`}>
            <Monitor size={14} />
          </div>
        </div>
      </button>

      <a
        href={GITHUB_REPO}
        target="_blank"
        rel="noopener noreferrer"
        className="p-1.5 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors text-zinc-600 dark:text-zinc-300 cursor-pointer"
        title="GitHub Repository"
      >
        <Github size={14} />
      </a>
    </div>
  );
}
