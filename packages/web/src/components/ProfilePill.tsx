import { getAnonymousInitial, getStableColor } from '@markdawn/shared';
import clsx from 'clsx';
import { LogIn, LogOut, PanelLeftClose, PanelLeftOpen, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useShareContext } from '../contexts/ShareContext';
import { useAuth } from '../hooks/useAuth';
import { authClient } from '../lib/auth-client';
import { ThemeToggle } from './ThemeToggle';
import { Tooltip } from './Tooltip';

interface ProfilePillProps {
  className?: string;
  collapsed?: boolean;
  isActuallyCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function ProfilePill({
  className,
  collapsed = false,
  isActuallyCollapsed,
  onToggleCollapsed,
}: ProfilePillProps) {
  const navigate = useNavigate();

  const { data: session } = useAuth();
  const { isAnonymous, anonymousId, anonymousName } = useShareContext();

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          navigate('/login');
        },
      },
    });
  };

  const renderAvatar = (size: 'sm' | 'lg') => {
    const sizeClasses = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
    const textSize = size === 'sm' ? 'text-sm' : 'text-base';

    if (isAnonymous && anonymousId) {
      const bgColor = getStableColor(anonymousId);
      const initial = getAnonymousInitial(anonymousId);
      return (
        <div
          className={`${sizeClasses} rounded-full flex items-center justify-center font-medium text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10`}
          style={{ backgroundColor: bgColor }}
        >
          <span className={textSize}>{initial}</span>
        </div>
      );
    }

    if (session?.user?.image) {
      return (
        <img
          src={session.user.image}
          alt={session.user.name || 'User'}
          className={`${sizeClasses} rounded-full object-cover`}
          referrerPolicy="no-referrer"
        />
      );
    }

    return (
      <div
        className={`${sizeClasses} rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800`}
      >
        <User size={size === 'sm' ? 16 : 18} />
      </div>
    );
  };

  return (
    <div
      className={clsx(
        'rounded-[2rem] border border-white/60 dark:border-zinc-700/50 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] flex-shrink-0 z-50 relative overflow-visible flex flex-col justify-center',
        collapsed ? 'w-[68px] min-h-[160px] py-4' : 'w-[240px] p-3',
        className,
      )}
    >
      {/* Collapsed State */}
      <div
        className={clsx(
          'absolute inset-0 flex flex-col items-center justify-between py-5 transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)]',
          collapsed
            ? 'opacity-100 translate-x-0 pointer-events-auto delay-100'
            : 'opacity-0 -translate-x-8 pointer-events-none',
        )}
      >
        <div className="flex flex-col items-center gap-4 w-full">
          <ThemeToggle />
          <Tooltip label="Open Sidebar (Ctrl+/)" position="right">
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="p-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-xl hover:bg-zinc-900/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
            >
              <PanelLeftOpen size={20} />
            </button>
          </Tooltip>
          {renderAvatar('lg')}
          {isAnonymous ? (
            <Tooltip label="Sign In" position="right">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-xl hover:bg-zinc-900/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                title="Sign In"
              >
                <LogIn size={20} />
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={handleSignOut}
              className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded-xl hover:bg-red-500/10 transition-colors cursor-pointer"
              title="Sign Out"
            >
              <LogOut size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded State */}
      <div
        className={clsx(
          'flex flex-col transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] w-full',
          collapsed
            ? 'opacity-0 translate-x-8 pointer-events-none absolute'
            : 'opacity-100 translate-x-0 pointer-events-auto delay-100 relative',
        )}
      >
        <div className="flex items-center justify-between px-1 mb-2">
          <ThemeToggle />
          {!isAnonymous && (
            <Tooltip
              label={`${(isActuallyCollapsed ?? collapsed) ? 'Open' : 'Close'} Sidebar (Ctrl+/)`}
              position="top"
            >
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="p-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
              >
                {(isActuallyCollapsed ?? collapsed) ? (
                  <PanelLeftOpen size={18} />
                ) : (
                  <PanelLeftClose size={18} />
                )}
              </button>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/50 dark:hover:bg-zinc-800/50 transition-colors group">
          {renderAvatar('sm')}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {isAnonymous ? anonymousName : session?.user?.name || 'User'}
            </div>
            {!isAnonymous && (
              <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                {session?.user?.email}
              </div>
            )}
          </div>
          {isAnonymous ? (
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-zinc-900/5 dark:hover:bg-white/10 transition-all cursor-pointer"
              title="Sign In"
            >
              <LogIn size={16} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSignOut}
              className="p-1.5 text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/10 transition-all cursor-pointer"
              title="Sign Out"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
