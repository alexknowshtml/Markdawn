import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import { db } from '../db/connection';
import { executeQuery, query } from '../db/query';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import {
  hasValidImageSignature,
  IMAGE_EXTENSION_BY_MIME,
  isSafeImageMime,
  MAX_IMAGE_SIZE_BYTES,
} from '../utils/image-upload';
import { ensurePageAccess, lockEntityAccessMutation } from '../utils/share-access';

const uploadsRoute = new Hono();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UploadRow = {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  uploaded_by: string;
};

const getUploadByFilename = async (filename: string) => {
  const result = await query<UploadRow>('select * from uploads where filename = $1 limit 1', [
    filename,
  ]);
  return result.rows[0] ?? null;
};

const canUserAccessUpload = async (uploadId: string, userId: string): Promise<boolean> => {
  const result = await query(
    `SELECT 1
     FROM upload_page_refs upr
     JOIN LATERAL get_effective_page_permission(upr.page_id, $2) access ON true
     WHERE upr.upload_id = $1
       AND access.permission IS NOT NULL
     LIMIT 1`,
    [uploadId, userId],
  );
  return (result.rowCount ?? 0) > 0;
};

const isUploadPublic = async (uploadId: string): Promise<boolean> => {
  const result = await query(
    `SELECT 1
     FROM upload_page_refs upr
     JOIN pages p ON p.id = upr.page_id AND p.is_deleted = false
     WHERE upr.upload_id = $1
       AND (
         (
           p.is_public = true
           AND EXISTS (
             SELECT 1
             FROM shares s
             WHERE s.entity_type = 'page'
               AND s.entity_id = p.id
               AND s.token IS NOT NULL
               AND (s.expires_at IS NULL OR s.expires_at > now())
           )
         )
         OR EXISTS (
           SELECT 1
           FROM folder_closure fc
           JOIN folders f ON f.id = fc.ancestor_id
           JOIN shares s ON s.entity_type = 'folder'
             AND s.entity_id = f.id
             AND s.token IS NOT NULL
             AND (s.expires_at IS NULL OR s.expires_at > now())
           WHERE fc.descendant_id = p.parent_id
             AND f.is_public = true
             AND f.is_deleted = false
             AND NOT is_page_folder_inheritance_blocked(f.id, p.id)
         )
       )
     LIMIT 1`,
    [uploadId],
  );
  return (result.rowCount ?? 0) > 0;
};

uploadsRoute.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid form data' });
  }

  const file = (body as Record<string, unknown>).file;
  const pageId = (body as Record<string, unknown>).pageId;

  if (typeof pageId !== 'string' || !UUID_PATTERN.test(pageId)) {
    throw new HTTPException(400, { message: 'Page ID is required' });
  }

  await ensurePageAccess(pageId, user.id, 'edit');

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }

  if (!isSafeImageMime(file.type)) {
    throw new HTTPException(400, { message: 'Only JPEG, PNG, GIF, and WebP images are allowed' });
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new HTTPException(400, { message: 'File must be 10MB or less' });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!hasValidImageSignature(buffer, file.type)) {
    throw new HTTPException(400, { message: 'File contents do not match the selected image type' });
  }

  await mkdir(uploadsDir, { recursive: true });

  const extension = IMAGE_EXTENSION_BY_MIME.get(file.type);
  if (!extension) {
    throw new HTTPException(400, { message: 'Unsupported image type' });
  }
  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(uploadsDir, filename);
  await writeFile(filePath, buffer);

  try {
    await db.transaction(async (tx) => {
      await lockEntityAccessMutation(tx, 'page', pageId);
      await ensurePageAccess(pageId, user.id, 'edit', tx);
      const uploadResult = await executeQuery<{ id: string }>(
        tx,
        `insert into uploads (filename, original_name, mime_type, size, uploaded_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [filename, file.name, file.type, file.size, user.id],
      );
      const uploadId = uploadResult.rows[0]?.id;
      if (!uploadId) {
        throw new HTTPException(500, { message: 'Failed to create upload' });
      }

      await executeQuery(
        tx,
        `insert into upload_page_refs (upload_id, page_id)
         values ($1, $2)
         on conflict (upload_id, page_id) do nothing`,
        [uploadId, pageId],
      );
    });
  } catch (error) {
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Upload failed and file cleanup was unsuccessful',
      );
    }
    throw error;
  }

  return c.json({ url: `/api/uploads/${filename}` });
});

uploadsRoute.get('/:filename', async (c) => {
  const filename = c.req.param('filename');

  // Validate filename - only allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9\-_.]+$/.test(filename)) {
    throw new HTTPException(400, { message: 'Invalid filename' });
  }

  const upload = await getUploadByFilename(filename);
  if (!upload) {
    throw new HTTPException(404, { message: 'Not found' });
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = session?.user as { id: string } | undefined;
  let cacheControl = 'private, max-age=3600';

  if (user) {
    if (upload.uploaded_by !== user.id && !(await canUserAccessUpload(upload.id, user.id))) {
      throw new HTTPException(403, { message: "You don't have access to this file" });
    }
  } else if (await isUploadPublic(upload.id)) {
    cacheControl = 'public, max-age=3600';
  } else {
    throw new HTTPException(404, { message: 'Not found' });
  }

  const filePath = path.join(uploadsDir, filename);

  try {
    const fileBuffer = await readFile(filePath);

    return c.body(fileBuffer, 200, {
      'Content-Type': upload.mime_type,
      'Content-Length': upload.size.toString(),
      'Cache-Control': cacheControl,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  } catch {
    throw new HTTPException(404, { message: 'File not found' });
  }
});

export default uploadsRoute;
