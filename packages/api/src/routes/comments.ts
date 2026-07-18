import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import {
  actorColumns,
  ensureActorPageAccess,
  getRequestActor,
  persistGuestIdentity,
  type RequestActor,
} from '../utils/guestAccess';
import { lockEntityAccess } from '../utils/share-access';

type AuthorRow = {
  account_author_id: string | null;
  guest_author_id: string | null;
  author_name: string;
  author_avatar_url: string | null;
};

type CommentRow = AuthorRow & {
  id: string;
  page_id: string;
  content: string;
  anchor_block_id: string | null;
  resolved: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type ReplyRow = AuthorRow & {
  id: string;
  comment_id: string;
  content: string;
  created_at: Date | null;
};

const commentsRoute = new Hono();

function isActorAuthor(actor: RequestActor, author: AuthorRow): boolean {
  return actor.kind === 'user'
    ? author.account_author_id === actor.id
    : author.guest_author_id === actor.id;
}

function publicAuthorId(author: AuthorRow): string | null {
  return author.account_author_id;
}

function actorUser(actor: RequestActor) {
  return actor.kind === 'user'
    ? query<{ id: string; name: string; avatar_url: string | null }>(
        'select id, name, avatar_url from users where id = $1',
        [actor.id],
      ).then((result) => {
        const user = result.rows[0];
        if (!user) throw new HTTPException(404, { message: 'User not found' });
        return { id: user.id, name: user.name, avatarUrl: user.avatar_url };
      })
    : Promise.resolve({ id: null, name: actor.name, avatarUrl: null });
}

commentsRoute.get(':pageId/comments', async (c) => {
  const pageId = c.req.param('pageId');
  const actor = await getRequestActor(c);
  return db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensureActorPageAccess(actor, pageId, 'view', tx);

    const commentsResult = await executeQuery<CommentRow>(
      tx,
      `select comment.id, comment.page_id, comment.content, comment.anchor_block_id,
              comment.resolved, comment.created_at, comment.updated_at,
              account.id as account_author_id,
              guest.id as guest_author_id,
              coalesce(account.name, guest.name) as author_name,
              coalesce(account.avatar_url, account.image) as author_avatar_url
       from comments comment
       left join users account on account.id = comment.user_id
       left join guest_identities guest on guest.id = comment.guest_id
       where comment.page_id = $1
       order by comment.created_at`,
      [pageId],
    );
    const commentIds = commentsResult.rows.map((row) => row.id);
    const repliesByComment = new Map<string, ReplyRow[]>();
    if (commentIds.length > 0) {
      const replies = await executeQuery<ReplyRow>(
        tx,
        `select reply.id, reply.comment_id, reply.content, reply.created_at,
                account.id as account_author_id,
                guest.id as guest_author_id,
                coalesce(account.name, guest.name) as author_name,
                coalesce(account.avatar_url, account.image) as author_avatar_url
         from comment_replies reply
         left join users account on account.id = reply.user_id
         left join guest_identities guest on guest.id = reply.guest_id
         where reply.comment_id = any($1::uuid[])
         order by reply.created_at`,
        [commentIds],
      );
      for (const reply of replies.rows) {
        const list = repliesByComment.get(reply.comment_id) ?? [];
        list.push(reply);
        repliesByComment.set(reply.comment_id, list);
      }
    }

    return c.json(
      commentsResult.rows.map((comment) => ({
        id: comment.id,
        pageId: comment.page_id,
        userId: publicAuthorId(comment),
        isOwn: isActorAuthor(actor, comment),
        content: comment.content,
        anchorBlockId: comment.anchor_block_id,
        resolved: comment.resolved ?? false,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        user: {
          id: publicAuthorId(comment),
          name: comment.author_name,
          avatarUrl: comment.author_avatar_url,
        },
        replies: (repliesByComment.get(comment.id) ?? []).map((reply) => ({
          id: reply.id,
          commentId: reply.comment_id,
          userId: publicAuthorId(reply),
          isOwn: isActorAuthor(actor, reply),
          content: reply.content,
          createdAt: reply.created_at,
          user: {
            id: publicAuthorId(reply),
            name: reply.author_name,
            avatarUrl: reply.author_avatar_url,
          },
        })),
      })),
    );
  });
});

commentsRoute.post(':pageId/comments', async (c) => {
  const pageId = c.req.param('pageId');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Invalid body' });
  const { content, anchorBlockId } = body as { content?: unknown; anchorBlockId?: unknown };
  if (typeof content !== 'string' || content.length === 0) {
    throw new HTTPException(400, { message: 'content is required' });
  }
  if (anchorBlockId !== undefined && anchorBlockId !== null && typeof anchorBlockId !== 'string') {
    throw new HTTPException(400, { message: 'anchorBlockId must be a string' });
  }
  const author = await actorUser(actor);
  const columns = actorColumns(actor);
  const result = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensureActorPageAccess(actor, pageId, 'edit', tx);
    await persistGuestIdentity(actor, tx);
    return executeQuery(
      tx,
      `insert into comments (page_id, user_id, guest_id, content, anchor_block_id)
       values ($1, $2, $3, $4, $5)
       returning id, page_id, content, anchor_block_id, resolved, created_at, updated_at`,
      [pageId, columns.userId, columns.guestId, content, anchorBlockId ?? null],
    );
  });
  const row = result.rows[0];
  if (!row) throw new HTTPException(500, { message: 'Failed to create comment' });
  return c.json({
    id: row.id,
    pageId: row.page_id,
    userId: actor.kind === 'user' ? actor.id : null,
    isOwn: true,
    content: row.content,
    anchorBlockId: row.anchor_block_id,
    resolved: row.resolved ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: author,
    replies: [],
  });
});

commentsRoute.post(':pageId/comments/:commentId/replies', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch(() => null);
  const content = body && typeof body === 'object' ? (body as { content?: unknown }).content : null;
  if (typeof content !== 'string' || content.length === 0) {
    throw new HTTPException(400, { message: 'content is required' });
  }
  const author = await actorUser(actor);
  const columns = actorColumns(actor);
  const result = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensureActorPageAccess(actor, pageId, 'edit', tx);
    await persistGuestIdentity(actor, tx);
    const comment = await executeQuery(
      tx,
      'select id from comments where id = $1 and page_id = $2',
      [commentId, pageId],
    );
    if (comment.rowCount === 0) throw new HTTPException(404, { message: 'Comment not found' });
    return executeQuery(
      tx,
      `insert into comment_replies (comment_id, user_id, guest_id, content)
       values ($1, $2, $3, $4)
       returning id, comment_id, content, created_at`,
      [commentId, columns.userId, columns.guestId, content],
    );
  });
  const row = result.rows[0];
  if (!row) throw new HTTPException(500, { message: 'Failed to create reply' });
  return c.json({
    id: row.id,
    commentId: row.comment_id,
    userId: actor.kind === 'user' ? actor.id : null,
    isOwn: true,
    content: row.content,
    createdAt: row.created_at,
    user: author,
  });
});

commentsRoute.patch(':pageId/comments/:commentId', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');
  const actor = await getRequestActor(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Invalid body' });
  const { content, resolved } = body as { content?: unknown; resolved?: unknown };

  const update = await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensureActorPageAccess(actor, pageId, 'edit', tx);
    const existing = await executeQuery<{ user_id: string | null; guest_id: string | null }>(
      tx,
      'select user_id, guest_id from comments where id = $1 and page_id = $2',
      [commentId, pageId],
    );
    const comment = existing.rows[0];
    if (!comment) throw new HTTPException(404, { message: 'Comment not found' });
    const isAuthor =
      (actor.kind === 'user' && comment.user_id === actor.id) ||
      (actor.kind === 'guest' && comment.guest_id === actor.id);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (content !== undefined) {
      if (typeof content !== 'string') {
        throw new HTTPException(400, { message: 'content must be a string' });
      }
      if (!isAuthor) {
        throw new HTTPException(403, { message: 'You can only edit your own comments' });
      }
      values.push(content);
      updates.push(`content = $${values.length}`);
    }
    if (resolved !== undefined) {
      if (typeof resolved !== 'boolean') {
        throw new HTTPException(400, { message: 'resolved must be a boolean' });
      }
      values.push(resolved);
      updates.push(`resolved = $${values.length}`);
    }
    if (updates.length === 0) throw new HTTPException(400, { message: 'No fields to update' });
    values.push(commentId, pageId);
    const result = await executeQuery(
      tx,
      `update comments set ${updates.join(', ')}, updated_at = now()
       where id = $${values.length - 1} and page_id = $${values.length}
       returning id, page_id, content, anchor_block_id, resolved, created_at, updated_at`,
      values,
    );
    return {
      result,
      userId: comment.user_id,
      isOwn: isAuthor,
    };
  });
  const row = update.result.rows[0];
  if (!row) throw new HTTPException(404, { message: 'Comment not found' });
  return c.json({
    id: row.id,
    pageId: row.page_id,
    userId: update.userId,
    isOwn: update.isOwn,
    content: row.content,
    anchorBlockId: row.anchor_block_id,
    resolved: row.resolved ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

commentsRoute.delete(':pageId/comments/:commentId', async (c) => {
  const pageId = c.req.param('pageId');
  const commentId = c.req.param('commentId');
  const actor = await getRequestActor(c);
  await db.transaction(async (tx) => {
    await lockEntityAccess(tx, 'page', pageId);
    await ensureActorPageAccess(actor, pageId, 'edit', tx);
    const existing = await executeQuery<{ user_id: string | null; guest_id: string | null }>(
      tx,
      'select user_id, guest_id from comments where id = $1 and page_id = $2',
      [commentId, pageId],
    );
    const comment = existing.rows[0];
    if (!comment) throw new HTTPException(404, { message: 'Comment not found' });
    const isAuthor =
      (actor.kind === 'user' && comment.user_id === actor.id) ||
      (actor.kind === 'guest' && comment.guest_id === actor.id);
    if (!isAuthor) {
      throw new HTTPException(403, { message: 'You can only delete your own comments' });
    }
    await executeQuery(tx, 'delete from comments where id = $1 and page_id = $2', [
      commentId,
      pageId,
    ]);
  });
  return c.json({ success: true });
});

export default commentsRoute;
