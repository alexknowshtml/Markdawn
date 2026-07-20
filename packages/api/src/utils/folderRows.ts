import type { folders } from '../db';

export type FolderRow = typeof folders.$inferSelect;
export type NormalizedFolderRow = FolderRow & { ownerId: string | null };

export type FolderDatabaseRow = {
  id: string;
  parent_id: string | null;
  name: string;
  icon: string | null;
  position: string;
  created_by: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  is_deleted: boolean | null;
  deleted_at: Date | null;
  deletion_batch_id: string | null;
  public_permission: 'view' | 'edit' | null;
  inheritance_policy: 'inherit' | 'restricted';
};

export type FolderDatabaseRowWithOwner = FolderDatabaseRow & { owner_id: string | null };

export function normalizeFolderRow(
  row: FolderDatabaseRow,
  ownerId: string | null,
): NormalizedFolderRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDeleted: row.is_deleted,
    deletedAt: row.deleted_at,
    deletionBatchId: row.deletion_batch_id,
    publicPermission: row.public_permission,
    inheritancePolicy: row.inheritance_policy,
    ownerId,
  };
}
