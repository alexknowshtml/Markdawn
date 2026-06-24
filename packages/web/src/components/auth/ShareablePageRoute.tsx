import { type CapabilitySet, deriveCapabilities } from '@markdawn/shared';
import { useQuery } from '@tanstack/react-query';
import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { type PublicFolderPayload, ShareProvider } from '../../contexts/ShareContext';
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
): Promise<PublicEntityPayload> {
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

export function ShareablePageRoute({ entityType, children }: ShareablePageRouteProps) {
  const { data: session, isPending: authPending } = useAuth();
  const location = useLocation();
  const { slugAndId } = useParams<{ slugAndId: string }>();
  const entityId = slugAndId ? extractUuid(slugAndId) : null;
  const shouldFetchPublicEntity =
    !authPending && !!entityId && (!session?.user || entityType === 'folder');

  const {
    data: entity,
    isLoading: entityLoading,
    error: entityError,
  } = useQuery({
    queryKey: [entityType === 'folder' ? 'folders' : 'pages', 'detail', entityId],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchEntityPublic(entityType, entityId);
    },
    enabled: shouldFetchPublicEntity,
    retry: false,
  });

  const {
    data: sharesData,
    isLoading: sharesLoading,
    error: sharesError,
  } = useQuery({
    queryKey: ['shares', 'entity', entityType, entityId],
    queryFn: () => {
      if (!entityId) throw new Error('entityId is required');
      return fetchEntityShares(entityType, entityId);
    },
    enabled: !authPending && !!entityId && !!session?.user && entityType === 'folder',
    retry: false,
  });

  const isLoading =
    authPending ||
    (entityType === 'folder' && sharesLoading) ||
    (shouldFetchPublicEntity && entityLoading);

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

  if (entityType === 'folder' && sharesError instanceof ApiError && sharesError.status === 403) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4 text-center max-w-md p-8">
          <ShieldOff size={48} className="text-zinc-300 dark:text-zinc-600" />
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            You don&apos;t have access
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Your access to this folder may have been removed. Contact the owner to request access.
          </p>
        </div>
      </div>
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
      publicEntity={entityType === 'folder' ? entity : null}
    >
      {children}
    </ShareProvider>
  );
}
