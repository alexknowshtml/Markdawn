import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pool } from '../db/connection';
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

const ensureWorkspaceMember = async (workspaceId: string, userId: string) => {
  const result = await pool.query(
    'select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1',
    [workspaceId, userId],
  );

  if (result.rowCount === 0) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
};

const getUploadByFilename = async (filename: string) => {
  const result = await pool.query('select * from uploads where filename = $1 limit 1', [filename]);
  return result.rows[0] ?? null;
};

uploadsRoute.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new HTTPException(400, { message: 'Invalid form data' });
  }

  const file = (body as Record<string, unknown>).file;
  const workspaceId = (body as Record<string, unknown>).workspaceId;

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new HTTPException(400, { message: 'workspaceId is required' });
  }

  // Verify workspace membership
  await ensureWorkspaceMember(workspaceId, user.id);

  const extension = ALLOWED_IMAGE_TYPES.get(file.type);
  if (!extension) {
    throw new HTTPException(400, { message: 'Only image files are allowed' });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new HTTPException(400, { message: 'File must be 10MB or less' });
  }

  const uploadDir = path.resolve(__dirname, '..', '..', 'uploads');
  await mkdir(uploadDir, { recursive: true });

  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(uploadDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  // Save upload record to database
  await pool.query(
    `insert into uploads (filename, original_name, mime_type, size, workspace_id, uploaded_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [filename, file.name, file.type, file.size, workspaceId, user.id],
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

  // Check workspace membership
  await ensureWorkspaceMember(upload.workspace_id, user.id);

  const filePath = path.resolve(__dirname, '..', '..', 'uploads', filename);

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
