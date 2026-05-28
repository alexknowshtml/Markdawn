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
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | string | null;
  isPublic?: boolean;
  publicToken?: string | null;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  position: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | string | null;
}

export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[];
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[];
}

export type ShareEntityType = 'folder' | 'page';
export type SharePermission = 'view' | 'edit';

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
  permission: SharePermission;
  source: string;
}

export interface ShareSummary {
  entity: {
    type: ShareEntityType;
    id: string;
    title: string;
  };
  link: {
    permission: SharePermission | 'private';
    token: string | null;
    url: string | null;
  };
  invites: EntityShare[];
  accessors: EntityAccessor[];
}

export interface SharedWithMeItem extends EntityShare {
  title: string;
  icon: string | null;
}
