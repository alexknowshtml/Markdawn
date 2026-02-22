export interface Page {
  id: string;
  workspaceId: string | null;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverType: string | null;
  coverValue: string | null;
  position: number;
  ydoc: Uint8Array | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | string | null;
  isPublic?: boolean;
  publicToken?: string | null;
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[];
}