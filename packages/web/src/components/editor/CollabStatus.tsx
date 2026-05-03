import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { WebSocketStatus } from '@hocuspocus/provider';
import React, { useEffect, useState } from 'react';
import { Tooltip } from '../Tooltip';

type CollabStatusProps = {
  provider: HocuspocusProvider | null;
  status: ProviderStatus;
};

type ProviderStatus = WebSocketStatus;

const STATUS_LABELS: Record<ProviderStatus, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  disconnected: 'Offline',
};

const STATUS_COLORS: Record<ProviderStatus, string> = {
  connecting: 'bg-amber-500',
  connected: 'bg-emerald-500',
  disconnected: 'bg-rose-500',
};

export function CollabStatus({ provider, status }: CollabStatusProps) {
  const [userCount, setUserCount] = useState(1);

  useEffect(() => {
    if (!provider) {
      return;
    }

    const updateUsers = () => {
      const awareness = provider.awareness;
      const count = awareness ? awareness.getStates().size : 1;
      setUserCount(count || 1);
    };

    provider.awareness?.on('change', updateUsers);
    updateUsers();

    return () => {
      provider.awareness?.off('change', updateUsers);
    };
  }, [provider]);

  const label = STATUS_LABELS[status] ?? 'Connecting';
  const dotClass = STATUS_COLORS[status] ?? STATUS_COLORS.connecting;

  if (!provider) {
    return null;
  }

  return (
    <Tooltip label={label} position="bottom">
      <span
        className={
          'relative flex w-9 h-9 items-center justify-center rounded-md transition-colors duration-200 group-hover:bg-zinc-100 dark:group-hover:bg-zinc-800 cursor-pointer'
        }
      >
        <span
          className={`inline-flex h-3 w-3 rounded-full transition-colors duration-300 ${dotClass}`}
        />
      </span>
    </Tooltip>
  );
}
