import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

export interface CommentUser {
  id: string;
  name: string;
  image: string | null;
}

export interface CommentReply {
  id: string;
  commentId: string;
  userId: string;
  content: string;
  createdAt: string;
  user?: CommentUser;
}

export interface Comment {
  id: string;
  pageId: string;
  userId: string;
  content: string;
  anchorBlockId: string | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  user?: CommentUser;
  replies?: CommentReply[];
}

async function fetchComments(pageId: string): Promise<Comment[]> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/comments`);
  if (!res.ok) {
    throw new Error('Failed to fetch comments');
  }
  return res.json();
}

async function createComment(
  pageId: string,
  content: string,
  anchorBlockId?: string,
): Promise<Comment> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, anchorBlockId }),
  });
  if (!res.ok) {
    throw new Error('Failed to create comment');
  }
  return res.json();
}

async function addReply(pageId: string, commentId: string, content: string): Promise<CommentReply> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/comments/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error('Failed to add reply');
  }
  return res.json();
}

async function updateComment(
  pageId: string,
  commentId: string,
  updates: { content?: string; resolved?: boolean },
): Promise<Comment> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error('Failed to update comment');
  }
  return res.json();
}

async function deleteComment(pageId: string, commentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/comments/${commentId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to delete comment');
  }
}

export function useComments(pageId: string | undefined) {
  return useQuery({
    queryKey: ['comments', pageId],
    queryFn: () => {
      if (!pageId) throw new Error('pageId is required');
      return fetchComments(pageId);
    },
    enabled: !!pageId,
  });
}

export function useCreateComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ content, anchorBlockId }: { content: string; anchorBlockId?: string }) => {
      if (!pageId) throw new Error('pageId is required');
      return createComment(pageId, content, anchorBlockId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Comment added');
    },
    meta: { errorMessage: 'Failed to add comment' },
  });
}

export function useAddReply(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, content }: { commentId: string; content: string }) => {
      if (!pageId) throw new Error('pageId is required');
      return addReply(pageId, commentId, content);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Reply added');
    },
    meta: { errorMessage: 'Failed to add reply' },
  });
}

export function useUpdateComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      commentId,
      updates,
    }: {
      commentId: string;
      updates: { content?: string; resolved?: boolean };
    }) => {
      if (!pageId) throw new Error('pageId is required');
      return updateComment(pageId, commentId, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    meta: { errorMessage: 'Failed to update comment' },
  });
}

export function useDeleteComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => {
      if (!pageId) throw new Error('pageId is required');
      return deleteComment(pageId, commentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Comment deleted');
    },
    meta: { errorMessage: 'Failed to delete comment' },
  });
}
