import type { ShareEntityType, SharePermission } from '@markdawn/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { markSelfLeave } from './leave-page';
import { showSuccessToast } from './toast';

const API_BASE = '/api';

export type EntityShareSource = 'direct' | 'link' | 'workspace';

type EntityBase = {
  id: string;
  type: ShareEntityType;
  ownerId?: string | null | undefined;
  createdBy?: string | null | undefined;
  userPermission?: SharePermission | null | undefined;
  shareSource?: EntityShareSource | undefined;
};

type DeleteEntityOptions = {
  force?: boolean | undefined;
};

type UseEntityDeletionParams = {
  entityType: ShareEntityType;
  currentUserId?: string | undefined;
  onSuccess?: (() => void) | undefined;
};

export type DeleteEntityResult =
  | { deleted: true }
  | { requiresForce: true; childFolders: number; childPages: number; message: string };

type UseEntityDeletionReturn = {
  handleDelete: (entity: EntityBase, options?: DeleteEntityOptions) => Promise<DeleteEntityResult>;
  isPending: boolean;
};

async function leaveEntity(
  entityType: ShareEntityType,
  entityId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/${entityType}s/${entityId}/leave`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ message: `Failed to remove ${entityType} from your view` }));
    throw new Error(error.message);
  }
  return res.json();
}

async function bulkLeaveEntities(entityType: ShareEntityType, entityIds: string[]): Promise<void> {
  const results = await Promise.allSettled(entityIds.map((id) => leaveEntity(entityType, id)));
  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount > 0) {
    const removedCount = results.length - failedCount;
    throw new Error(`${removedCount} removed, ${failedCount} failed`);
  }
}

export interface OwnedEntity {
  ownerId?: string | null | undefined;
  createdBy?: string | null | undefined;
}

export function isOwnedByUser(entity: OwnedEntity, userId: string): boolean {
  return (entity.ownerId ?? entity.createdBy) === userId;
}

/**
 * Moving an item to a workspace root makes its creator the effective owner.
 * Only offer that destination when doing so preserves the current owner.
 */
export function preservesEffectiveOwnerAtRoot(entity: OwnedEntity): boolean {
  return entity.ownerId != null && entity.createdBy === entity.ownerId;
}

export function useLeaveEntity(entityType: ShareEntityType) {
  const queryClient = useQueryClient();
  const queryKeyMap: Record<ShareEntityType, string[]> = {
    page: ['pageTree'],
    folder: ['folderTree'],
  };

  return useMutation({
    mutationFn: (entityId: string) => leaveEntity(entityType, entityId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyMap[entityType] });
      const otherKey = entityType === 'page' ? 'folderTree' : 'pageTree';
      queryClient.invalidateQueries({ queryKey: [otherKey] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      showSuccessToast('Removed from your view');
    },
  });
}

export function useBulkLeaveEntities(entityType: ShareEntityType) {
  const queryClient = useQueryClient();
  const queryKeyMap: Record<ShareEntityType, string[]> = {
    page: ['pageTree'],
    folder: ['folderTree'],
  };

  return useMutation({
    mutationFn: ({ entityIds }: { entityIds: string[] }) =>
      bulkLeaveEntities(entityType, entityIds),
    onSuccess: () => {
      showSuccessToast('Removed from your view');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyMap[entityType] });
      const otherKey = entityType === 'page' ? 'folderTree' : 'pageTree';
      queryClient.invalidateQueries({ queryKey: [otherKey] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

async function deleteEntity(
  entityType: ShareEntityType,
  entityId: string,
  force?: boolean,
): Promise<DeleteEntityResult> {
  const url =
    entityType === 'folder' && force
      ? `${API_BASE}/${entityType}s/${entityId}?force=true`
      : `${API_BASE}/${entityType}s/${entityId}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    throw new Error(`Invalid delete ${entityType} response`, { cause: error });
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Invalid delete ${entityType} response`);
  }
  const result = payload as {
    code?: unknown;
    deleted?: unknown;
    requiresForce?: unknown;
    childFolders?: unknown;
    childPages?: unknown;
    message?: unknown;
  };
  if (
    entityType === 'folder' &&
    res.status === 409 &&
    result.code === 'FOLDER_NOT_EMPTY' &&
    result.requiresForce === true &&
    typeof result.childFolders === 'number' &&
    typeof result.childPages === 'number'
  ) {
    return {
      requiresForce: true,
      childFolders: result.childFolders,
      childPages: result.childPages,
      message:
        'message' in result && typeof result.message === 'string'
          ? result.message
          : 'Folder is not empty',
    };
  }
  if (!res.ok) {
    throw new Error(
      typeof result.message === 'string' ? result.message : `Failed to delete ${entityType}`,
    );
  }
  if (result.deleted !== true) {
    throw new Error(`Invalid delete ${entityType} response`);
  }
  return { deleted: true };
}

export function useEntityDeletion({
  entityType,
  currentUserId,
  onSuccess,
}: UseEntityDeletionParams): UseEntityDeletionReturn {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: ({ entityId, force }: { entityId: string; force?: boolean | undefined }) =>
      deleteEntity(entityType, entityId, force),
    onSuccess: (result) => {
      if ('requiresForce' in result) return;
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['folderTree'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      if (entityType === 'page') {
        queryClient.invalidateQueries({ queryKey: ['trashPages'] });
      }
      showSuccessToast(entityType === 'page' ? 'Moved to trash' : 'Moved to trash');
      onSuccess?.();
    },
  });

  const leaveMutation = useLeaveEntity(entityType);

  const handleDelete = async (entity: EntityBase, options?: DeleteEntityOptions) => {
    const isOwned = currentUserId ? isOwnedByUser(entity, currentUserId) : false;
    const canDelete = isOwned || entity.userPermission === 'admin';

    if (canDelete) {
      return deleteMutation.mutateAsync({ entityId: entity.id, force: options?.force });
    }

    if (entity.shareSource !== 'direct' && entity.shareSource !== 'link') {
      throw new Error(`This ${entity.type} inherits access and cannot be left directly`);
    }

    if (entity.type === 'page') {
      markSelfLeave(entity.id);
    }
    await leaveMutation.mutateAsync(entity.id);
    return { deleted: true as const };
  };

  return {
    handleDelete,
    isPending: deleteMutation.isPending || leaveMutation.isPending,
  };
}
