import type React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

type ProtectedRouteProps = {
  children: React.ReactNode;
};

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { data: session, isPending } = useAuth();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4 w-full max-w-md p-8">
          <div className="h-12 w-12 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-shimmer" />
          <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-800 animate-shimmer" />
          <div className="h-3 w-48 rounded bg-zinc-100 dark:bg-zinc-900 animate-shimmer" />
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
