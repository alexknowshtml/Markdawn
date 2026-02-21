import React, { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";

type CollabStatusProps = {
  provider: HocuspocusProvider | null;
  status: ProviderStatus;
};

type ProviderStatus = WebSocketStatus;

const STATUS_LABELS: Record<ProviderStatus, string> = {
  connecting: "Connecting",
  connected: "Live",
  disconnected: "Offline",
};

const STATUS_COLORS: Record<ProviderStatus, string> = {
  connecting: "bg-amber-500",
  connected: "bg-emerald-500",
  disconnected: "bg-rose-500",
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

    provider.awareness?.on("change", updateUsers);
    updateUsers();

    return () => {
      provider.awareness?.off("change", updateUsers);
    };
  }, [provider]);

  const label = STATUS_LABELS[status] ?? "Connecting";
  const dotClass = STATUS_COLORS[status] ?? STATUS_COLORS.connecting;

  if (!provider) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-100/80 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-700/50 transition-all duration-300 shadow-sm">
      <div className="relative flex h-2 w-2 items-center justify-center">
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-300 ${dotClass}`} />
      </div>
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300 transition-colors duration-300">
        {label}
      </span>
      {userCount > 1 && (
        <>
          <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-600" />
          <div className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
            <span className="text-xs font-medium">{userCount}</span>
          </div>
        </>
      )}
    </div>
  );
}
