import type { ShareEntityType } from '@markdawn/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { markSelfLeave } from './leave-page';
import { showSuccessToast } from './toast';

const API_BASE = '/api';

type EntityBase = {
  id: string;
  type: ShareEntityType;
  ownerId?: string | null | undefined;
  createdBy?: string | null | undefined;
};

type DeleteEntityOptions = {
  force?: boolean | undefined;
};

type UseEntityDeletionParams = {
  entityType: ShareEntityType;
  currentUserId?: string | undefined;
  onSuccess?: (() => void) | undefined;
};

type UseEntityDeletionReturn = {
  handleDelete: (entity: EntityBase, options?: DeleteEntityOptions) => Promise<void>;
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
  await Promise.all(entityIds.map((id) => leaveEntity(entityType, id)));
}

export interface OwnedEntity {
  ownerId?: string | null | undefined;
  createdBy?: string | null | undefined;
}

export function isOwnedByUser(entity: OwnedEntity, userId: string): boolean {
  return (entity.ownerId ?? entity.createdBy) === userId;
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

async function deleteEntity(
  entityType: ShareEntityType,
  entityId: string,
  force?: boolean,
): Promise<void> {
  const url =
    entityType === 'folder' && force
      ? `${API_BASE}/${entityType}s/${entityId}?force=true`
      : `${API_BASE}/${entityType}s/${entityId}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: `Failed to delete ${entityType}` }));
    throw new Error(error.message);
  }
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
    onSuccess: () => {
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

    if (isOwned) {
      await deleteMutation.mutateAsync({ entityId: entity.id, force: options?.force });
    } else {
      if (entity.type === 'page') {
        markSelfLeave(entity.id);
      }
      await leaveMutation.mutateAsync(entity.id);
    }
  };

  return {
    handleDelete,
    isPending: deleteMutation.isPending || leaveMutation.isPending,
  };
}
