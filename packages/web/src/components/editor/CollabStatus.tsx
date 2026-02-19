import React, { useEffect, useMemo, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

type CollabStatusProps = {
  provider: HocuspocusProvider | null;
};

type ProviderStatus = "connecting" | "connected" | "disconnected";

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

export function CollabStatus({ provider }: CollabStatusProps) {
  const [status, setStatus] = useState<ProviderStatus>("connecting");
  const [userCount, setUserCount] = useState(1);

  useEffect(() => {
    if (!provider) return;

    const handleStatus = ({ status: nextStatus }: { status: ProviderStatus }) => {
      setStatus(nextStatus);
    };

    const updateUsers = () => {
      const awareness = provider.awareness;
      const count = awareness ? awareness.getStates().size : 1;
      setUserCount(count || 1);
    };

    provider.on("status", handleStatus);
    provider.awareness?.on("change", updateUsers);
    updateUsers();

    return () => {
      provider.off("status", handleStatus);
      provider.awareness?.off("change", updateUsers);
    };
  }, [provider]);

  const label = STATUS_LABELS[status] ?? "Connecting";
  const dotClass = STATUS_COLORS[status] ?? STATUS_COLORS.connecting;
  const userLabel = useMemo(() => {
    if (userCount <= 1) return null;
    return `${userCount} users`;
  }, [userCount]);

  if (!provider) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      {userLabel ? <span className="text-xs text-zinc-400">· {userLabel}</span> : null}
    </div>
  );
}
