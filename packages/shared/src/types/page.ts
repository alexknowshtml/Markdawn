export interface Page {
  id: string;
  workspaceId: string | null;
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
  workspaceId: string | null;
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
