export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string | null;
  isPersonal: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: Date;
}