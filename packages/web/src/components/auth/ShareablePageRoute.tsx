import { type CapabilitySet, deriveCapabilities } from '@markdawn/shared';
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
};

type Accessor = {
  shareId: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  permission: 'view' | 'edit' | 'admin';
  source: string;
  isOwner: boolean;
};

type SharesResponse = {
  entity: { type: string; id: string; title: string; ownerId: string | null };
  link: { permission: 'view' | 'edit' | 'private'; token: string | null; url: string | null };
  accessors: Accessor[];
  userPermission: 'view' | 'edit' | 'admin' | null;
  capabilities: CapabilitySet;
};

function extractUuid(slugAndId: string): string | null {
  const match = slugAndId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

async function fetchEntityPublic(
  entityType: EntityType,
  entityId: string,
  shareToken: string | null,
): Promise<PublicEntityPayload> {
  const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
  const res = await fetch(
    `/api/${entityType === 'folder' ? 'folders' : 'pages'}/${entityId}${query}`,
  );
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

async function fetchEntityShares(
  entityType: EntityType,
  entityId: string,
): Promise<SharesResponse> {
  const res = await fetch(`/api/shares/entity/${entityType}/${entityId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'Failed to fetch share info';
    throw new ApiError(res.status, message);
  }
  return res.json();
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
            ? `Your access may have been removed or the sharing link may have expired.`
            : isNotFound
              ? `It may have been deleted, or the sharing link is no longer active.`
              : 'The server returned an error. Your sharing settings have not been changed.'}
        </p>
        {kind === 'server' && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900 cursor-pointer"
          >
            <RefreshCw size={14} /> Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ShareablePageRoute({ entityType, children }: ShareablePageRouteProps) {
  const { data: session, isPending: authPending } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const entityId = slugAndId ? extractUuid(slugAndId) : null;
  const shareToken = new URLSearchParams(location.search).get('share')?.trim() || null;
  const shouldFetchPublicEntity =
    !authPending && !!entityId && (!session?.user || entityType === 'folder');

  const {
    data: entity,
    isLoading: entityLoading,
    error: entityError,
    refetch: refetchEntity,
  } = useQuery({
    queryKey: [entityType === 'folder' ? 'folders' : 'pages', 'detail', entityId, shareToken],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchEntityPublic(entityType, entityId, shareToken);
    },
    enabled: shouldFetchPublicEntity,
    retry: false,
    refetchInterval: entityType === 'folder' ? 5_000 : false,
    refetchIntervalInBackground: entityType === 'folder',
  });

  const {
    data: sharesData,
    isLoading: sharesLoading,
    error: sharesError,
    refetch: refetchShares,
  } = useQuery({
    queryKey: ['shares', 'entity', entityType, entityId],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchEntityShares(entityType, entityId);
    },
    enabled: !authPending && !!entityId && !!session?.user && entityType === 'folder',
    retry: false,
    refetchInterval: entityType === 'folder' ? 5_000 : false,
    refetchIntervalInBackground: entityType === 'folder',
  });

  const isLoading =
    authPending ||
    (entityType === 'folder' && sharesLoading) ||
    (shouldFetchPublicEntity && entityLoading);

  const folderAccessSignature = useMemo(() => {
    if (entityType !== 'folder' || isLoading || !entityId) return null;
    return JSON.stringify({
      entityId,
      isPublic: entity?.isPublic ?? null,
      linkPermission: entity?.linkPermission ?? null,
      shares: sharesData ?? null,
    });
  }, [entityType, isLoading, entityId, entity?.isPublic, entity?.linkPermission, sharesData]);
  const previousFolderAccessRef = useRef<{ entityId: string; signature: string } | null>(null);

  useEffect(() => {
    if (!entityId || folderAccessSignature === null) return;
    const previous = previousFolderAccessRef.current;
    previousFolderAccessRef.current = { entityId, signature: folderAccessSignature };
    if (previous?.entityId === entityId && previous.signature !== folderAccessSignature) {
      invalidateWorkspaceAccessQueries(queryClient);
    }
  }, [entityId, folderAccessSignature, queryClient]);

  useEffect(() => {
    if (entityType !== 'folder' || !session?.user?.id || !entity?.isPublic) {
      return;
    }
    invalidateWorkspaceAccessQueries(queryClient);
  }, [entityType, session?.user?.id, entity?.isPublic, queryClient]);

  if (isLoading) {
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

  if (!session?.user && entityError instanceof ApiError && entityError.status === 403) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const routeError = entityError ?? sharesError;
  if (routeError) {
    const status = routeError instanceof ApiError ? routeError.status : 500;
    const kind = status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'server';
    return (
      <RouteErrorState
        kind={kind}
        entityType={entityType}
        onRetry={() => {
          void Promise.all([
            ...(shouldFetchPublicEntity ? [refetchEntity()] : []),
            ...(entityType === 'folder' && session?.user ? [refetchShares()] : []),
          ]);
        }}
      />
    );
  }

  if (session?.user) {
    if (entityType === 'folder') {
      const permission = sharesData?.userPermission ?? null;
      const capabilities = sharesData?.capabilities ?? deriveCapabilities(permission);
      const linkPermission = permission === 'admin' ? 'edit' : permission;
      return (
        <ShareProvider
          linkPermission={linkPermission}
          shareToken={shareToken}
          capabilities={capabilities}
          publicEntity={entity ?? null}
        >
          {children}
        </ShareProvider>
      );
    }

    return <ShareProvider>{children}</ShareProvider>;
  }

  if (!entityId) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!entity?.isPublic) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <ShareProvider
      linkPermission={entity.linkPermission ?? null}
      shareToken={shareToken}
      publicEntity={entityType === 'folder' ? entity : null}
    >
      {children}
    </ShareProvider>
  );
}
