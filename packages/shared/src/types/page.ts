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
  isPublic?: boolean;
  publicToken?: string | null;
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
  isPublic?: boolean;
  publicToken?: string | null;
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
export type InheritancePolicy = 'inherit' | 'restricted';

export interface EntityShare {
  id: string;
  entityType: ShareEntityType;
  entityId: string;
  permission: SharePermission;
  token: string | null;
  recipientUserId: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  recipientAvatarUrl: string | null;
  sharedByName: string | null;
  sharedByEmail: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface EntityAccessor {
  shareId: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  permission: SharePermission;
  source: string;
  isOwner: boolean;
}

export interface CapabilitySet {
  canEdit: boolean;
  canComment: boolean;
  canDelete: boolean;
  canCopy: boolean;
}

export function deriveCapabilities(
  permission: SharePermission | null,
  isOwner = false,
): CapabilitySet {
  if (isOwner) {
    return { canEdit: true, canComment: true, canDelete: true, canCopy: true };
  }
  switch (permission) {
    case 'admin':
      return { canEdit: true, canComment: true, canDelete: true, canCopy: true };
    case 'edit':
      return { canEdit: true, canComment: true, canDelete: false, canCopy: true };
    case 'view':
      return {
        canEdit: false,
        canComment: false,
        canDelete: false,
        canCopy: true,
      };
    default:
      return {
        canEdit: false,
        canComment: false,
        canDelete: false,
        canCopy: false,
      };
  }
}

export interface PermissionDetail {
  source: 'owner' | 'invite' | 'folder' | 'workspace' | 'link';
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
  entity: {
    type: ShareEntityType;
    id: string;
    title: string;
    ownerId: string | null;
  };
  link: {
    permission: SharePermission | 'private';
    token: string | null;
    url: string | null;
  };
  inheritance: {
    policy: InheritancePolicy;
  };
  invites: EntityShare[];
  accessors: EntityAccessor[];
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
  source: 'direct' | 'link';
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
  source?: 'direct' | 'link';
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
