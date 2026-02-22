import React from "react";

type EmptyStateProps = {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
};

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-6 px-3" : "py-12 px-6"
      }`}
    >
      <div
        className={`rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 ${
          compact ? "p-3" : "p-4"
        }`}
      >
        {icon}
      </div>
      <h3 className={`mt-4 font-semibold text-zinc-900 dark:text-zinc-100 ${compact ? "text-sm" : "text-base"}`}>
        {title}
      </h3>
      {description && (
        <p className={`mt-1 text-zinc-500 dark:text-zinc-400 ${compact ? "text-xs" : "text-sm"}`}>
          {description}
        </p>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 inline-flex items-center rounded-md bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
