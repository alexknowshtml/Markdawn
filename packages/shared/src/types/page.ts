export interface Page {
  id: string;
  workspaceId: string | null;
  parentId: string | null;
  title: string;
  icon: string | null;
  position: number;
  ydoc: Uint8Array | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[];
}