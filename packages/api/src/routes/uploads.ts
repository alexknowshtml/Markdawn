import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

const uploadsRoute = new Hono();

uploadsRoute.use('*', requireAuth);

const getUploadByFilename = async (filename: string) => {
  const result = await query('select * from uploads where filename = $1 limit 1', [filename]);
  return result.rows[0] ?? null;
};

uploadsRoute.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid form data' });
  }

  const file = (body as Record<string, unknown>).file;

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }

  const extension = ALLOWED_IMAGE_TYPES.get(file.type);
  if (!extension) {
    throw new HTTPException(400, { message: 'Only image files are allowed' });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new HTTPException(400, { message: 'File must be 10MB or less' });
  }

  await mkdir(uploadsDir, { recursive: true });

  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(uploadsDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  // Save upload record to database
  await query(
    `insert into uploads (filename, original_name, mime_type, size, uploaded_by)
     values ($1, $2, $3, $4, $5)`,
    [filename, file.name, file.type, file.size, user.id],
  );

  return c.json({ url: `/api/uploads/${filename}` });
});

uploadsRoute.get('/:filename', async (c) => {
  const user = c.get('user');
  const filename = c.req.param('filename');

  // Validate filename - only allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9\-_.]+$/.test(filename)) {
    throw new HTTPException(400, { message: 'Invalid filename' });
  }

  const upload = await getUploadByFilename(filename);
  if (!upload) {
    throw new HTTPException(404, { message: 'Not found' });
  }

  if (upload.uploaded_by !== user.id) {
    // Check if the user has access to any page by the upload owner (shared, workspace, etc.)
    const accessResult = await query(
      `SELECT 1 FROM pages p
	       WHERE p.created_by = $1
	         AND p.is_deleted = false
	         AND (
	           EXISTS (SELECT 1 FROM shares s WHERE s.entity_type = 'page' AND s.entity_id = p.id AND s.recipient_user_id = $2)
	           OR EXISTS (SELECT 1 FROM page_access_events pae WHERE pae.page_id = p.id AND pae.user_id = $2)
	           OR EXISTS (SELECT 1 FROM shares s
	                       JOIN folder_closure fc ON fc.ancestor_id = s.entity_id
	                      WHERE s.entity_type = 'folder' AND s.recipient_user_id = $2
	                        AND p.parent_id IS NOT NULL
	                        AND fc.descendant_id = p.parent_id)
	           OR EXISTS (SELECT 1 FROM workspace_members wm
	                       WHERE wm.workspace_owner_id = p.created_by AND wm.member_id = $2
	                         AND p.is_access_restricted IS NOT TRUE
	                         AND NOT EXISTS (
	                           SELECT 1 FROM folder_closure fc
	                           JOIN folders f ON f.id = fc.ancestor_id
	                           WHERE fc.descendant_id = p.parent_id
                             AND f.is_access_restricted = true AND f.is_deleted = false
                         ))
         )
       LIMIT 1`,
      [upload.uploaded_by, user.id],
    );
    if (accessResult.rowCount === 0) {
      throw new HTTPException(403, { message: "You don't have access to this file" });
    }
  }

  const filePath = path.join(uploadsDir, filename);

  try {
    const fileBuffer = await readFile(filePath);

    return c.body(fileBuffer, 200, {
      'Content-Type': upload.mime_type,
      'Content-Length': upload.size.toString(),
      'Cache-Control': 'private, max-age=3600',
    });
  } catch {
    throw new HTTPException(404, { message: 'File not found' });
  }
});

export default uploadsRoute;
