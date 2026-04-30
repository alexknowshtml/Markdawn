import React, { useState } from 'react';
import clsx from 'clsx';
import { 
  X, 
  MessageSquare, 
  CheckCircle2, 
  Circle, 
  Trash2, 
  CornerDownRight,
  Send
} from 'lucide-react';
import { 
  useComments, 
  useCreateComment, 
  useAddReply, 
  useUpdateComment, 
  useDeleteComment,
  Comment
} from '../../hooks/use-comments';
import { useAuth } from '../../hooks/useAuth';
import { ConfirmDialog } from '../ConfirmDialog';

interface CommentsSidebarProps {
  pageId: string;
  isOpen: boolean;
  onClose: () => void;
}

type FilterType = 'all' | 'open' | 'resolved';

export function CommentsSidebar({ pageId, isOpen, onClose }: CommentsSidebarProps) {
  const { data: session } = useAuth();
  const { data: comments = [], isLoading } = useComments(pageId);
  const createComment = useCreateComment(pageId);
  const addReply = useAddReply(pageId);
  const updateComment = useUpdateComment(pageId);
  const deleteComment = useDeleteComment(pageId);

  const [filter, setFilter] = useState<FilterType>('all');
  const [newCommentText, setNewCommentText] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [commentToDelete, setCommentToDelete] = useState<string | null>(null);

  const filteredComments = comments.filter(comment => {
    if (filter === 'open') return !comment.resolved;
    if (filter === 'resolved') return comment.resolved;
    return true;
  });

  const handleCreateComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;
    
    createComment.mutate({ content: newCommentText.trim() }, {
      onSuccess: () => setNewCommentText('')
    });
  };

  const handleAddReply = (e: React.FormEvent, commentId: string) => {
    e.preventDefault();
    if (!replyText.trim()) return;

    addReply.mutate({ commentId, content: replyText.trim() }, {
      onSuccess: () => {
        setReplyText('');
        setReplyingTo(null);
      }
    });
  };

  const toggleResolve = (comment: Comment) => {
    updateComment.mutate({ 
      commentId: comment.id, 
      updates: { resolved: !comment.resolved } 
    });
  };

  const handleDelete = (commentId: string) => {
    setCommentToDelete(commentId);
  };

  const handleConfirmDelete = () => {
    if (!commentToDelete) {
      return;
    }
    deleteComment.mutate(commentToDelete, {
      onSettled: () => setCommentToDelete(null),
    });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    }).format(date);
  };

  if (!isOpen) return null;

  return (
    <>
      <aside className="w-80 border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 h-full flex flex-col flex-shrink-0 z-40">
      <div className="h-14 px-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100 font-medium">
          <MessageSquare size={18} />
          <span>Comments</span>
        </div>
        <button 
          onClick={onClose}
          className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <form onSubmit={handleCreateComment} className="relative">
          <textarea
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
            placeholder="Add a comment..."
            className="w-full min-h-[80px] p-3 pr-10 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 dark:placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCreateComment(e);
              }
            }}
          />
          <button
            type="submit"
            disabled={!newCommentText.trim() || createComment.isPending}
            className="absolute bottom-3 right-3 p-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-md disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            <Send size={16} />
          </button>
        </form>

        <div className="flex items-center gap-1 mt-4 p-1 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg">
          {(['all', 'open', 'resolved'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                "flex-1 px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors",
                filter === f 
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm" 
                  : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : filteredComments.length === 0 ? (
          <div className="text-center py-8 text-zinc-500 dark:text-zinc-400 text-sm">
            No comments found.
          </div>
        ) : (
          filteredComments.map((comment) => (
            <div 
              key={comment.id} 
              className={clsx(
                "p-3 rounded-lg border transition-colors",
                comment.resolved 
                  ? "bg-zinc-50 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 opacity-75" 
                  : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 shadow-sm"
              )}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  {comment.user?.image ? (
                    <img src={comment.user.image} alt={comment.user.name} className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      {comment.user?.name?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  <div>
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {comment.user?.name || 'Unknown User'}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDate(comment.createdAt)}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => toggleResolve(comment)}
                    className={clsx(
                      "p-1.5 rounded-md transition-colors",
                      comment.resolved 
                        ? "text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20" 
                        : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                    )}
                    title={comment.resolved ? "Mark as unresolved" : "Mark as resolved"}
                  >
                    {comment.resolved ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                  </button>
                  
                  {(session?.user?.id === comment.userId) && (
                    <button
                      onClick={() => handleDelete(comment.id)}
                      className="p-1.5 text-zinc-400 hover:text-red-600 dark:hover:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Delete comment"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>

              <div className={clsx(
                "text-sm mb-3 whitespace-pre-wrap",
                comment.resolved ? "text-zinc-600 dark:text-zinc-400" : "text-zinc-800 dark:text-zinc-200"
              )}>
                {comment.content}
              </div>


              {comment.replies && comment.replies.length > 0 && (
                <div className="space-y-3 mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700/50">
                  {comment.replies.map((reply) => (
                    <div key={reply.id} className="flex items-start gap-2 pl-2">
                      <CornerDownRight size={14} className="text-zinc-400 mt-1 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          {reply.user?.image ? (
                            <img src={reply.user.image} alt={reply.user.name} className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                              {reply.user?.name?.[0]?.toUpperCase() || '?'}
                            </div>
                          )}
                          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                            {reply.user?.name || 'Unknown User'}
                          </span>
                          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                            {formatDate(reply.createdAt)}
                          </span>
                        </div>
                        <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                          {reply.content}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}


              {!comment.resolved && (
                <div className="mt-3">
                  {replyingTo === comment.id ? (
                    <form onSubmit={(e) => handleAddReply(e, comment.id)} className="relative mt-2">
                      <textarea
                        autoFocus
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Write a reply..."
                        className="w-full min-h-[60px] p-2 pr-8 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleAddReply(e, comment.id);
                          }
                          if (e.key === 'Escape') {
                            setReplyingTo(null);
                            setReplyText('');
                          }
                        }}
                      />
                      <div className="absolute bottom-2 right-2 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setReplyingTo(null);
                            setReplyText('');
                          }}
                          className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                        >
                          <X size={14} />
                        </button>
                        <button
                          type="submit"
                          disabled={!replyText.trim() || addReply.isPending}
                          className="p-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded disabled:opacity-50"
                        >
                          <Send size={14} />
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      onClick={() => setReplyingTo(comment.id)}
                      className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                    >
                      Reply
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      </aside>
      <ConfirmDialog
        isOpen={commentToDelete !== null}
        title="Delete comment"
        message="Are you sure you want to delete this comment?"
        confirmText="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => setCommentToDelete(null)}
        loading={deleteComment.isPending}
      />
    </>
  );
}
