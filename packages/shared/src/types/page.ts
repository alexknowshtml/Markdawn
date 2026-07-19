export interface Page {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverType: string | null;
  coverValue: string | null;
  position: string;
  ydoc: Uint8Array | null;
  properties: Record<string, unknown> | null;
  createdBy: string | null;
  ownerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | string | null;
  publicPermission?: PublicPermission | null;
  inheritancePolicy?: InheritancePolicy;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  position: string;
  createdBy: string | null;
  ownerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | string | null;
  publicPermission?: PublicPermission | null;
  inheritancePolicy?: InheritancePolicy;
}

export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[];
  userPermission?: SharePermission | null;
  workspaceAccess?: boolean;
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[];
  userPermission?: SharePermission | null;
  workspaceAccess?: boolean;
}

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit' | 'admin';
export type PublicPermission = Exclude<SharePermission, 'admin'>;
export type InheritancePolicy = 'inherit' | 'restricted';

export interface EntityShare {
  id: string;
  entityType: ShareEntityType;
  entityId: string;
  permission: SharePermission;
  recipientUserId: string;
  recipientEmail: string | null;
  recipientName: string | null;
  recipientAvatarUrl: string | null;
  sharedByName: string | null;
  sharedByEmail: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface EntityAccessor {
  grantId: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  permission: SharePermission;
  source: string;
  isOwner: boolean;
}

/** Non-manageable collaborator presence safe to show to ordinary viewers. */
export interface CollaboratorPresence {
  presenceId: string;
  name: string | null;
  avatarUrl: string | null;
}

export type CollaboratorDisplay = EntityAccessor | CollaboratorPresence;

/**
 * One independently manageable source of account access.
 *
 * A user can have several simultaneous sources (for example a direct View
 * grant and inherited Edit access). Keep those sources separate so the
 * management UI never hides a latent grant behind the currently winning one.
 */
export interface EntityAccessSource {
  kind: 'owner' | 'direct' | 'folder' | 'workspace';
  grantId: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  permission: SharePermission;
  effectivePermission: SharePermission;
  isWinning: boolean;
  isOwner: boolean;
  isManageable: boolean;
  folderId?: string | null;
  folderName?: string | null;
}

/** Public access inherited from an ancestor folder. */
export interface InheritedPublicAccess {
  entityId: string;
  entityTitle: string;
  permission: PublicPermission;
  url: string;
}

export interface CapabilitySet {
  canEdit: boolean;
  canDelete: boolean;
  canCopy: boolean;
}

export function deriveCapabilities(
  permission: SharePermission | null,
  isOwner = false,
): CapabilitySet {
  if (isOwner) {
    return { canEdit: true, canDelete: true, canCopy: true };
  }
  switch (permission) {
    case 'admin':
      return { canEdit: true, canDelete: true, canCopy: true };
    case 'edit':
      return { canEdit: true, canDelete: false, canCopy: true };
    case 'view':
      return {
        canEdit: false,
        canDelete: false,
        canCopy: true,
      };
    default:
      return {
        canEdit: false,
        canDelete: false,
        canCopy: false,
      };
  }
}

export interface PermissionDetail {
  source: 'owner' | 'grant' | 'folder' | 'workspace' | 'public';
  permission: SharePermission;
  grantedByName?: string | null;
  grantedByEmail?: string | null;
  folderName?: string | null;
  folderId?: string | null;
}

export interface InheritedAccessor {
  userId: string;
  name: string | null;
  email: string | null;
  permission: SharePermission;
  source: 'folder' | 'workspace';
  folderName?: string | null;
  folderId?: string | null;
}

export interface ShareSummary {
  /** Limited summaries intentionally omit sharing identities and topology. */
  visibility?: 'full' | 'limited';
  collaboratorCount?: number;
  entity: {
    type: ShareEntityType;
    id: string;
    title: string;
    ownerId: string | null;
  };
  publicAccess: {
    permission: PublicPermission | 'private';
    url: string;
  };
  inheritance: {
    policy: InheritancePolicy;
  };
  grants: EntityShare[];
  accessors: EntityAccessor[];
  /** Every account source, including weaker grants hidden by a stronger one. */
  accessSources: EntityAccessSource[];
  /** Active public access inherited from ancestor folders. */
  inheritedPublicAccess: InheritedPublicAccess[];
  /** Effective permission for the requesting user (highest across all sources). */
  userPermission: SharePermission | null;
  /** Computed capabilities derived from userPermission. */
  capabilities: CapabilitySet;
  /** Breakdown of all permission sources for the requesting user. */
  permissionDetails: PermissionDetail[];
  /** Users who have access via inheritance (workspace membership or folder). */
  inheritedAccessors: InheritedAccessor[];
}

export interface SharedWithMeItem extends EntityShare {
  title: string;
  icon: string | null;
  ownerId: string | null;
  entityUpdatedAt: Date | string | null;
  sortAt: Date | string | null;
  source: 'direct' | 'public';
}

interface SharedNavigationBase {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  ownerId: string | null;
  createdBy: string | null;
  updatedAt: Date | string | null;
  userPermission: SharePermission | null;
  source?: 'direct' | 'public';
  sortAt?: Date | string | null;
}

export interface SharedNavigationPage extends SharedNavigationBase {
  entityType: 'page';
}

export interface SharedNavigationFolder extends SharedNavigationBase {
  entityType: 'folder';
  children: SharedNavigationItem[];
}

export type SharedNavigationItem = SharedNavigationPage | SharedNavigationFolder;
