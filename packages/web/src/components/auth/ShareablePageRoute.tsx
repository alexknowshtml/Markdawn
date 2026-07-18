import type { CapabilitySet } from '@markdawn/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileQuestion, RefreshCw, ShieldOff } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { type PublicFolderPayload, ShareProvider } from '../../contexts/ShareContext';
import { invalidateWorkspaceAccessQueries } from '../../hooks/use-workspace';
import { useAuth } from '../../hooks/useAuth';
import { ApiError } from '../../utils/api';

type EntityType = 'page' | 'folder';
type PublicEntityPayload = PublicFolderPayload & {
  title?: string;
  ydoc?: unknown;
  userPermission?: 'view' | 'edit' | 'admin' | null;
  capabilities?: CapabilitySet;
};

function extractUuid(slugAndId: string): string | null {
  const match = slugAndId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

async function fetchEntity(entityType: EntityType, entityId: string): Promise<PublicEntityPayload> {
  const res = await fetch(`/api/${entityType === 'folder' ? 'folders' : 'pages'}/${entityId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Failed to fetch ${entityType}`;
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as PublicEntityPayload;
}

type ShareablePageRouteProps = {
  entityType: EntityType;
  children: ReactNode;
};

function RouteErrorState({
  kind,
  entityType,
  onRetry,
}: {
  kind: 'forbidden' | 'not-found' | 'server';
  entityType: EntityType;
  onRetry?: (() => void) | undefined;
}) {
  const isForbidden = kind === 'forbidden';
  const isNotFound = kind === 'not-found';
  return (
    <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950">
      <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
        {isForbidden ? (
          <ShieldOff size={48} className="text-zinc-300 dark:text-zinc-600" />
        ) : (
          <FileQuestion size={48} className="text-zinc-300 dark:text-zinc-600" />
        )}
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {isForbidden
            ? `You don't have access`
            : isNotFound
              ? `${entityType === 'folder' ? 'Folder' : 'Page'} not found`
              : `Couldn't load this ${entityType}`}
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {isForbidden
            ? 'Your access may have been removed or the item may now be restricted.'
            : isNotFound
              ? 'It may have been deleted.'
              : 'The server returned an error. Your sharing settings have not been changed.'}
        </p>
        {kind === 'server' && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            <RefreshCw size={14} /> Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ShareablePageRoute({ entityType, children }: ShareablePageRouteProps) {
  const { isPending: authPending } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const entityId = slugAndId ? extractUuid(slugAndId) : null;
  const {
    data: entity,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [entityType === 'folder' ? 'folders' : 'pages', 'detail', entityId],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchEntity(entityType, entityId);
    },
    enabled: !authPending && !!entityId,
    retry: false,
    refetchInterval: entityType === 'folder' ? 5_000 : false,
    refetchIntervalInBackground: entityType === 'folder',
  });

  const folderAccessSignature = useMemo(() => {
    if (entityType !== 'folder' || !entityId || !entity) return null;
    return JSON.stringify({
      entityId,
      publicPermission: entity.publicPermission ?? null,
      userPermission: entity.userPermission ?? null,
      capabilities: entity.capabilities ?? null,
    });
  }, [entity, entityId, entityType]);
  const previousFolderAccessRef = useRef<{ entityId: string; signature: string } | null>(null);

  useEffect(() => {
    if (!entityId || folderAccessSignature === null) return;
    const previous = previousFolderAccessRef.current;
    previousFolderAccessRef.current = { entityId, signature: folderAccessSignature };
    if (previous?.entityId === entityId && previous.signature !== folderAccessSignature) {
      invalidateWorkspaceAccessQueries(queryClient);
    }
  }, [entityId, folderAccessSignature, queryClient]);

  if (authPending || isLoading) {
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

  if (!entityId) {
    return <RouteErrorState kind="not-found" entityType={entityType} />;
  }

  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const kind = status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'server';
    return (
      <RouteErrorState
        kind={kind}
        entityType={entityType}
        onRetry={kind === 'server' ? () => void refetch() : undefined}
      />
    );
  }

  return (
    <ShareProvider
      publicPermission={entity?.publicPermission ?? null}
      {...(entity?.capabilities ? { capabilities: entity.capabilities } : {})}
      publicEntity={entityType === 'folder' ? (entity ?? null) : null}
    >
      {children}
    </ShareProvider>
  );
}
