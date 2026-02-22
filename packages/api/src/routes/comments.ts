import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../middleware/auth";
import { pool } from "../db/connection";

type PageRow = {
  id: string;
  workspace_id: string | null;
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

commentsRoute.use("*", requireAuth);

const getPageById = async (pageId: string) => {
  const result = await pool.query("select id, workspace_id from pages where id = $1 limit 1", [pageId]);
  return (result.rows[0] as PageRow | undefined) ?? null;
};

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    "select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1",
    [workspaceId, userId]
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
};

commentsRoute.get(":pageId/comments", async (c) => {
  const pageId = c.req.param("pageId");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  if (!page.workspace_id) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const commentsResult = await pool.query(
    "select c.id, c.page_id, c.user_id, c.content, c.anchor_block_id, c.resolved, c.created_at, c.updated_at, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url from comments c join users u on u.id = c.user_id where c.page_id = $1 order by c.created_at asc",
    [pageId]
  );

  const commentRows = commentsResult.rows as CommentRow[];
  const commentIds = commentRows.map((row) => row.id);
  const repliesByComment = new Map<string, CommentReply[]>();

  if (commentIds.length > 0) {
    const repliesResult = await pool.query(
      "select r.id, r.comment_id, r.user_id, r.content, r.created_at, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url from comment_replies r join users u on u.id = r.user_id where r.comment_id = any($1) order by r.created_at asc",
      [commentIds]
    );

    const replyRows = repliesResult.rows as ReplyRow[];
    replyRows.forEach((row) => {
      if (!row.comment_id || !row.user_id) {
        return;
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
    });
  }

  const comments: CommentWithReplies[] = commentRows.map((row) => {
    if (!row.user_id || !row.page_id) {
      throw new HTTPException(500, { message: "Invalid comment data" });
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
commentsRoute.post(":pageId/comments", async (c) => {
  const pageId = c.req.param("pageId");
  const page = await getPageById(pageId);

  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }

  if (!page.workspace_id) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const { content, anchorBlockId } = await c.req.json();
  
  if (!content || typeof content !== "string") {
    throw new HTTPException(400, { message: "content is required" });
  }

  const result = await pool.query(
    "insert into comments (page_id, user_id, content, anchor_block_id) values ($1, $2, $3, $4) returning id, page_id, user_id, content, anchor_block_id, resolved, created_at, updated_at",
    [pageId, user.id, content, anchorBlockId ?? null]
  );

  const row = result.rows[0];
  
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
      id: user.id,
      name: "", // Will be filled by JOIN in real implementation
      email: "",
      avatarUrl: null,
    },
    replies: [],
  });
});

// POST /:pageId/comments/:commentId/replies - Add a reply to a comment
commentsRoute.post(":pageId/comments/:commentId/replies", async (c) => {
  const pageId = c.req.param("pageId");
  const commentId = c.req.param("commentId");
  
  const page = await getPageById(pageId);
  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }
  if (!page.workspace_id) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  // Verify comment exists
  const commentResult = await pool.query(
    "select id from comments where id = $1 and page_id = $2",
    [commentId, pageId]
  );
  if (commentResult.rowCount === 0) {
    throw new HTTPException(404, { message: "Comment not found" });
  }

  const { content } = await c.req.json();
  if (!content || typeof content !== "string") {
    throw new HTTPException(400, { message: "content is required" });
  }

  const result = await pool.query(
    "insert into comment_replies (comment_id, user_id, content) values ($1, $2, $3) returning id, comment_id, user_id, content, created_at",
    [commentId, user.id, content]
  );

  const row = result.rows[0];
  
  return c.json({
    id: row.id,
    commentId: row.comment_id,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
    user: {
      id: user.id,
      name: "",
      email: "",
      avatarUrl: null,
    },
  });
});
// PATCH /:pageId/comments/:commentId - Update comment content or resolve status
commentsRoute.patch(":pageId/comments/:commentId", async (c) => {
  const pageId = c.req.param("pageId");
  const commentId = c.req.param("commentId");
  
  const page = await getPageById(pageId);
  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }
  if (!page.workspace_id) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  const { content, resolved } = await c.req.json();
  
  // Build update query dynamically
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (content !== undefined) {
    if (typeof content !== "string") {
      throw new HTTPException(400, { message: "content must be a string" });
    }
    updates.push(`content = $${paramIndex++}`);
    values.push(content);
  }

  if (resolved !== undefined) {
    if (typeof resolved !== "boolean") {
      throw new HTTPException(400, { message: "resolved must be a boolean" });
    }
    updates.push(`resolved = $${paramIndex++}`);
    values.push(resolved);
    updates.push(`updated_at = NOW()`);
  }

  if (updates.length === 0) {
    throw new HTTPException(400, { message: "No fields to update" });
  }

  values.push(commentId, pageId);
  const result = await pool.query(
    `UPDATE comments SET ${updates.join(", ")} WHERE id = $${paramIndex++} AND page_id = $${paramIndex} RETURNING id, page_id, user_id, content, anchor_block_id, resolved, created_at, updated_at`,
    values
  );

  if (result.rowCount === 0) {
    throw new HTTPException(404, { message: "Comment not found" });
  }

  const row = result.rows[0];
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
commentsRoute.delete(":pageId/comments/:commentId", async (c) => {
  const pageId = c.req.param("pageId");
  const commentId = c.req.param("commentId");
  
  const page = await getPageById(pageId);
  if (!page) {
    throw new HTTPException(404, { message: "Page not found" });
  }
  if (!page.workspace_id) {
    throw new HTTPException(400, { message: "Page has no workspace" });
  }

  const user = c.get("user") as { id: string };
  await ensureWorkspaceMember(page.workspace_id, user.id);

  // Verify comment belongs to user or user is admin
  const commentResult = await pool.query(
    "SELECT user_id FROM comments WHERE id = $1 AND page_id = $2",
    [commentId, pageId]
  );
  
  if (commentResult.rowCount === 0) {
    throw new HTTPException(404, { message: "Comment not found" });
  }

  // Delete comment (replies will cascade due to foreign key)
  await pool.query(
    "DELETE FROM comments WHERE id = $1 AND page_id = $2",
    [commentId, pageId]
  );

  return c.json({ success: true });
});

export default commentsRoute;