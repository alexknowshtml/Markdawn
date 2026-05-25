import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

interface LoadingSkeletonProps {
  type?: 'tree' | 'cards' | 'editor';
  className?: string;
}

export function LoadingSkeleton({ type = 'tree', className }: LoadingSkeletonProps) {
  if (type === 'tree') {
    return (
      <div className={clsx('flex flex-col gap-3 p-4', className)}>
        <div className="flex items-center justify-center mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400 dark:text-zinc-500" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="h-4 w-3/4 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-1/2 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-5/6 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-2/3 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-4/5 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (type === 'cards') {
    return (
      <div
        className={clsx(
          'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4',
          className,
        )}
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={`skeleton-${String(i)}`}
            className="flex flex-col gap-3 p-4 border border-zinc-200 dark:border-zinc-800 rounded-lg bg-white dark:bg-zinc-900"
          >
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
              <div className="h-5 w-1/2 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
            </div>
            <div className="h-4 w-full bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse mt-2" />
            <div className="h-4 w-3/4 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
            <div className="flex items-center justify-between mt-4">
              <div className="h-3 w-1/3 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
              <div className="h-6 w-6 bg-zinc-200 dark:bg-zinc-800 rounded-full animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (type === 'editor') {
    return (
      <div className={clsx('max-w-4xl mx-auto w-full px-8 py-12', className)}>
        <div className="h-12 w-3/4 bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse mb-8" />
        <div className="space-y-4">
          <div className="h-4 w-full bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-full bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-5/6 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-full bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse mt-8" />
          <div className="h-4 w-4/5 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-4 w-full bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
          <div className="h-32 w-full bg-zinc-200 dark:bg-zinc-800 rounded-lg animate-pulse mt-8" />
        </div>
      </div>
    );
  }

  return null;
}
