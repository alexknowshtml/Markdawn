export type WorkspaceRole = 'viewer' | 'editor' | 'admin';

export interface WorkspaceMembership {
  ownerId: string;
  ownerName: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceOwnerId: string;
  memberId: string;
  memberName: string | null;
  memberEmail: string;
  memberAvatarUrl: string | null;
  role: WorkspaceRole;
  createdAt: string;
}
