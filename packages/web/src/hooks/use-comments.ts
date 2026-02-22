import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { showSuccessToast, showErrorToast } from '../utils/toast';

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

async function createComment(pageId: string, content: string, anchorBlockId?: string): Promise<Comment> {
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

async function updateComment(pageId: string, commentId: string, updates: { content?: string; resolved?: boolean }): Promise<Comment> {
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
    queryFn: () => fetchComments(pageId!),
    enabled: !!pageId,
  });
}

export function useCreateComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ content, anchorBlockId }: { content: string; anchorBlockId?: string }) =>
      createComment(pageId!, content, anchorBlockId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Comment added');
    },
    onError: () => {
      showErrorToast('Failed to add comment');
    },
  });
}

export function useAddReply(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, content }: { commentId: string; content: string }) =>
      addReply(pageId!, commentId, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Reply added');
    },
    onError: () => {
      showErrorToast('Failed to add reply');
    },
  });
}

export function useUpdateComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, updates }: { commentId: string; updates: { content?: string; resolved?: boolean } }) =>
      updateComment(pageId!, commentId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
    },
    onError: () => {
      showErrorToast('Failed to update comment');
    },
  });
}

export function useDeleteComment(pageId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => deleteComment(pageId!, commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', pageId] });
      showSuccessToast('Comment deleted');
    },
    onError: () => {
      showErrorToast('Failed to delete comment');
    },
  });
}
