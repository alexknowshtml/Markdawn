import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { requireAuth } from '../middleware/auth';
import { ensurePageAccess, lockEntityAccessMutation } from '../utils/share-access';

type UserRow = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

type CommentRow = {
  id: string;
  page_id: string | null;
  user_id: string | null;
  content: string;
  anchor_block_id: string | null;
  resolved: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  user_name: string;
  user_email: string;
  user_avatar_url: string | null;
};

type ReplyRow = {
  id: string;
  comment_id: string | null;
  user_id: string | null;
  content: string;
  created_at: Date | null;
  user_name: string;
  user_email: string;
  user_avatar_url: string | null;
};

type CommentUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
};

type CommentReply = {
  id: string;
  commentId: string;
  userId: string;
  content: string;
  createdAt: Date | null;
  user: CommentUser;
};

type CommentWithReplies = {
  id: string;
  pageId: string;
  userId: string;
  content: string;
  anchorBlockId: string | null;
  resolved: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  user: CommentUser;
  replies: CommentReply[];
};

const commentsRoute = new Hono();

commentsRoute.use('*', requireAuth);

const getUserById = async (userId: string) => {
  const result = await query(
    'select id, name, email, avatar_url from users where id = $1 limit 1',
    [userId],
  );
  return (result.rows[0] as UserRow | undefined) ?? null;
};

const ensurePageExists = async (pageId: string) => {
  const result = await query('select id from pages where id = $1 limit 1', [pageId]);
  return !!result.rows[0];
};

commentsRoute.get(':pageId/comments', async (c) => {
  const pageId = c.req.param('pageId');
  if (!(await ensurePageExists(pageId))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  const commentsResult = await query(
    'select c.id, c.page_id, c.user_id, c.content, c.anchor_block_id, c.resolved, c.created_at, c.updated_at, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url from comments c join users u on u.id = c.user_id where c.page_id = $1 order by c.created_at asc',
    [pageId],
  );

  const commentRows = commentsResult.rows as CommentRow[];
  const commentIds = commentRows.map((row) => row.id);
  const repliesByComment = new Map<string, CommentReply[]>();

  if (commentIds.length > 0) {
    const repliesResult = await query(
      'select r.id, r.comment_id, r.user_id, r.content, r.created_at, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url from comment_replies r join users u on u.id = r.user_id where r.comment_id = any($1) order by r.created_at asc',
      [commentIds],
    );

    const replyRows = repliesResult.rows as ReplyRow[];
    for (const row of replyRows) {
      if (!row.comment_id || !row.user_id) {
        continue;
      }
      const list = repliesByComment.get(row.comment_id) ?? [];
      list.push({
        id: row.id,
        commentId: row.comment_id,
        userId: row.user_id,
        content: row.content,
        createdAt: row.created_at ?? null,
        user: {
          id: row.user_id,
          name: row.user_name,
          email: row.user_email,
          avatarUrl: row.user_avatar_url ?? null,
        },
      });
      repliesByComment.set(row.comment_id, list);
    }
  }

  const comments: CommentWithReplies[] = commentRows.map((row) => {
    if (!row.user_id || !row.page_id) {
      throw new HTTPException(500, { message: 'Invalid comment data' });
    }

    return {
      id: row.id,
      pageId: row.page_id,
      userId: row.user_id,
      content: row.content,
      anchorBlockId: row.anchor_block_id ?? null,
      resolved: row.resolved ?? false,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      user: {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        avatarUrl: row.user_avatar_url ?? null,
      },
      replies: repliesByComment.get(row.id) ?? [],
    };
  });

  return c.json(comments);
});

// POST /:pageId/comments - Create a new comment
commentsRoute.post(':pageId/comments', async (c) => {
  const pageId = c.req.param('pageId');
  if (!(await ensurePageExists(pageId))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);
  const currentUser = await getUserById(user.id);
  if (!currentUser) {
    throw new HTTPException(404, { message: 'User not found' });
  }

  const { content, anchorBlockId } = await c.req.json();

  if (!content || typeof content !== 'string') {
    throw new HTTPException(400, { message: 'content is required' });
  }

  const result = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    return executeQuery(
      tx,
      'insert into comments (page_id, user_id, content, anchor_block_id) values ($1, $2, $3, $4) returning id, page_id, user_id, content, anchor_block_id, resolved, created_at, updated_at',
      [pageId, user.id, content, anchorBlockId ?? null],
    );
  });

  const row = result.rows[0];
  if (!row) {
    throw new HTTPException(500, { message: 'Failed to create comment' });
  }

  return c.json({
    id: row.id,
    pageId: row.page_id,
    userId: row.user_id,
    content: row.content,
    anchorBlockId: row.anchor_block_id,
    resolved: row.resolved ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      avatarUrl: currentUser.avatar_url ?? null,
    },
    replies: [],
  });
});

// POST /:pageId/comments/:commentId/replies - Add a reply to a comment
commentsRoute.post(':pageId/comments/:commentId/replies', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');

  if (!(await ensurePageExists(pageId))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);
  const currentUser = await getUserById(user.id);
  if (!currentUser) {
    throw new HTTPException(404, { message: 'User not found' });
  }

  const { content } = await c.req.json();
  if (!content || typeof content !== 'string') {
    throw new HTTPException(400, { message: 'content is required' });
  }

  const result = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    const commentResult = await executeQuery(
      tx,
      'select id from comments where id = $1 and page_id = $2',
      [commentId, pageId],
    );
    if (commentResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Comment not found' });
    }

    return executeQuery(
      tx,
      'insert into comment_replies (comment_id, user_id, content) values ($1, $2, $3) returning id, comment_id, user_id, content, created_at',
      [commentId, user.id, content],
    );
  });

  const row = result.rows[0];
  if (!row) {
    throw new HTTPException(500, { message: 'Failed to create reply' });
  }

  return c.json({
    id: row.id,
    commentId: row.comment_id,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
    user: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      avatarUrl: currentUser.avatar_url ?? null,
    },
  });
});
// PATCH /:pageId/comments/:commentId - Update comment content or resolve status
commentsRoute.patch(':pageId/comments/:commentId', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');

  if (!(await ensurePageExists(pageId))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  const { content, resolved } = await c.req.json();

  const result = await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    const commentResult = await executeQuery(
      tx,
      'SELECT user_id FROM comments WHERE id = $1 AND page_id = $2',
      [commentId, pageId],
    );
    if (commentResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Comment not found' });
    }

    const commentOwnerId = (commentResult.rows[0] as { user_id: string | null }).user_id;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (content !== undefined) {
      if (typeof content !== 'string') {
        throw new HTTPException(400, { message: 'content must be a string' });
      }
      if (!commentOwnerId || commentOwnerId !== user.id) {
        throw new HTTPException(403, { message: 'You can only edit your own comments' });
      }
      updates.push(`content = $${paramIndex++}`);
      values.push(content);
    }

    if (resolved !== undefined) {
      if (typeof resolved !== 'boolean') {
        throw new HTTPException(400, { message: 'resolved must be a boolean' });
      }
      updates.push(`resolved = $${paramIndex++}`);
      values.push(resolved);
    }

    if (updates.length === 0) {
      throw new HTTPException(400, { message: 'No fields to update' });
    }
    updates.push('updated_at = NOW()');
    values.push(commentId, pageId);
    return executeQuery(
      tx,
      `UPDATE comments SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND page_id = $${paramIndex} RETURNING id, page_id, user_id, content, anchor_block_id, resolved, created_at, updated_at`,
      values,
    );
  });

  if (result.rowCount === 0) {
    throw new HTTPException(404, { message: 'Comment not found' });
  }

  const row = result.rows[0];
  if (!row) {
    throw new HTTPException(500, { message: 'Failed to update comment' });
  }
  return c.json({
    id: row.id,
    pageId: row.page_id,
    userId: row.user_id,
    content: row.content,
    anchorBlockId: row.anchor_block_id,
    resolved: row.resolved ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// DELETE /:pageId/comments/:commentId - Delete a comment (cascades to replies)
commentsRoute.delete(':pageId/comments/:commentId', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');

  if (!(await ensurePageExists(pageId))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  const user = c.get('user') as { id: string };
  await ensurePageAccess(pageId, user.id);

  await db.transaction(async (tx) => {
    await lockEntityAccessMutation(tx, 'page', pageId);
    await ensurePageAccess(pageId, user.id, 'view', tx);
    const commentResult = await executeQuery(
      tx,
      'SELECT user_id FROM comments WHERE id = $1 AND page_id = $2',
      [commentId, pageId],
    );
    if (commentResult.rowCount === 0) {
      throw new HTTPException(404, { message: 'Comment not found' });
    }

    const commentOwnerId = (commentResult.rows[0] as { user_id: string | null }).user_id;
    if (!commentOwnerId || commentOwnerId !== user.id) {
      throw new HTTPException(403, { message: 'You can only delete your own comments' });
    }

    // Delete comment (replies will cascade due to foreign key)
    await executeQuery(tx, 'DELETE FROM comments WHERE id = $1 AND page_id = $2', [
      commentId,
      pageId,
    ]);
  });

  return c.json({ success: true });
});

export default commentsRoute;
