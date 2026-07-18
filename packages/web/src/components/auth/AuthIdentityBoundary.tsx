import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import {
  createIdentityLifecycle,
  IdentityLifecycleProvider,
} from '../../contexts/IdentityLifecycleContext';
import { useAuth } from '../../hooks/useAuth';
import { createQueryClient, retireQueryClient } from '../../lib/query-client';
import { resetBulkRemovalState } from '../../utils/bulkRemovalState';
import { resetDocumentMetadata } from '../../utils/documentMeta';
import { resetSelfLeaveState } from '../../utils/leave-page';
import { clearToasts } from '../../utils/toast';
import { AppProviders } from '../AppProviders';

const ANONYMOUS_IDENTITY = 'anonymous';

function IdentityLoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950">
      <div className="flex w-full max-w-md flex-col items-center gap-4 p-8">
        <div className="h-12 w-12 animate-shimmer rounded-full bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-4 w-32 animate-shimmer rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-3 w-48 animate-shimmer rounded bg-zinc-100 dark:bg-zinc-900" />
      </div>
    </div>
  );
}

/**
 * Prevents state owned by one authenticated identity from being observed by
 * the next identity in the same browser tab. Each resolved identity receives
 * an independent QueryClient, while the prior client and other process-local
 * UI state are retired before the new route tree can be painted.
 */
export function AuthIdentityBoundary({ children }: { children: ReactNode }) {
  const { data: session, isPending, isRefetching } = useAuth();
  const parentQueryClient = useQueryClient();
  const identityUncertain = isPending || isRefetching;
  const resolvedIdentity = identityUncertain ? null : (session?.user?.id ?? ANONYMOUS_IDENTITY);
  const identityQueryClient = useMemo(
    () =>
      resolvedIdentity === null ? null : createQueryClient(parentQueryClient.getDefaultOptions()),
    [parentQueryClient, resolvedIdentity],
  );
  const identityLifecycle = useMemo(
    () => (resolvedIdentity === null ? null : createIdentityLifecycle()),
    [resolvedIdentity],
  );
  const previousIdentityRef = useRef<string | null>(null);
  const previousQueryClientRef = useRef(identityQueryClient);
  const previousLifecycleRef = useRef(identityLifecycle);

  useLayoutEffect(() => {
    const previousLifecycle = previousLifecycleRef.current;
    if (previousLifecycle && previousLifecycle !== identityLifecycle) {
      previousLifecycle.retire();
    }
    previousLifecycleRef.current = identityLifecycle;

    const previousQueryClient = previousQueryClientRef.current;
    if (previousQueryClient && previousQueryClient !== identityQueryClient) {
      retireQueryClient(previousQueryClient);
    }
    previousQueryClientRef.current = identityQueryClient;

    const identityChanged = previousIdentityRef.current !== resolvedIdentity;
    previousIdentityRef.current = resolvedIdentity;
    if (identityUncertain || identityChanged) {
      clearToasts();
      resetDocumentMetadata();
      resetSelfLeaveState();
      resetBulkRemovalState();
      window.getSelection()?.removeAllRanges();
    }
  }, [identityLifecycle, identityQueryClient, identityUncertain, resolvedIdentity]);

  if (
    identityUncertain ||
    resolvedIdentity === null ||
    identityQueryClient === null ||
    identityLifecycle === null
  ) {
    return <IdentityLoadingState />;
  }

  return (
    <IdentityLifecycleProvider lifecycle={identityLifecycle}>
      <QueryClientProvider client={identityQueryClient}>
        <AppProviders key={resolvedIdentity}>{children}</AppProviders>
      </QueryClientProvider>
    </IdentityLifecycleProvider>
  );
}
