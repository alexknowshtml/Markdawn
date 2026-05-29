import type { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import { getInitial } from '../../utils/avatar';
import { Tooltip } from '../Tooltip';

type CollabStatusProps = {
  provider: HocuspocusProvider | null;
  status: WebSocketStatus;
};

type AwarenessUser = {
  id: number;
  name: string;
  color: string;
  avatar?: string;
  emoji?: string;
};

const STATUS_LABELS: Record<WebSocketStatus, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  disconnected: 'Offline',
};

export function CollabStatus({ provider, status }: CollabStatusProps) {
  const [users, setUsers] = useState<AwarenessUser[]>([]);

  useEffect(() => {
    if (!provider) {
      return;
    }

    const updateUsers = () => {
      const awareness = provider.awareness;
      if (!awareness) return;

      const states = awareness.getStates();
      const localClientId = awareness.clientID;
      const seen = new Map<string, AwarenessUser>();

      for (const [clientId, state] of states.entries()) {
        if (clientId === localClientId) continue;
        if (state.user && typeof state.user === 'object') {
          const user = state.user as {
            name?: string;
            color?: string;
            avatar?: string;
            emoji?: string;
          };

          const key = user.avatar ?? user.name ?? 'Anonymous';
          if (!seen.has(key)) {
            seen.set(key, {
              id: clientId,
              name: user.name ?? 'Anonymous',
              color: user.color ?? '#000000',
              ...(user.avatar ? { avatar: user.avatar } : {}),
              ...(user.emoji ? { emoji: user.emoji } : {}),
            });
          }
        }
      }

      setUsers(Array.from(seen.values()));
    };

    provider.awareness?.on('change', updateUsers);
    updateUsers();

    return () => {
      provider.awareness?.off('change', updateUsers);
    };
  }, [provider]);

  const label = STATUS_LABELS[status] ?? 'Connecting';
  const statusColor =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
        ? 'bg-amber-500'
        : 'bg-rose-500';

  return (
    <div className="flex items-center gap-3">
      {/* Status Indicator */}
      <Tooltip label={label} position="bottom">
        <span className="relative flex w-9 h-9 items-center justify-center rounded-md transition-colors duration-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">
          <span
            className={`inline-flex h-3 w-3 rounded-full transition-colors duration-300 ${statusColor}`}
          />
        </span>
      </Tooltip>

      {/* User Avatars — only when provider is available */}
      {provider && users.length > 0 && (
        <div className="flex items-center -space-x-2">
          {users.slice(0, 5).map((user) => (
            <Tooltip key={user.id} label={user.name} position="bottom">
              <div
                className="relative w-8 h-8 rounded-full border-[2.5px] bg-zinc-100 dark:bg-zinc-800 overflow-hidden flex items-center justify-center transition-transform hover:scale-110 hover:z-10"
                style={{
                  borderColor: user.color,
                  backgroundColor: user.avatar ? undefined : user.color,
                }}
              >
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : user.emoji ? (
                  <span className="text-base">{user.emoji}</span>
                ) : (
                  <span className="text-white text-xs font-bold">{getInitial(user.name)}</span>
                )}
              </div>
            </Tooltip>
          ))}
          {users.length > 5 && (
            <Tooltip label={`${users.length - 5} more users`} position="bottom">
              <div className="w-8 h-8 rounded-full border-2 border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                +{users.length - 5}
              </div>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
