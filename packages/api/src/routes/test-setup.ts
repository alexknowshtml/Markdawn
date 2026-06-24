import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { query } from '../db/query';

const router = new Hono();

/**
 * Dev-only test setup endpoint for Playwright E2E tests.
 * Creates a test user and returns a signed session cookie.
 * Disabled in production.
 */
router.post('/test/setup', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    throw new HTTPException(403, { message: 'Test setup is disabled in production' });
  }

  const testToken = process.env.TEST_SETUP_TOKEN;
  if (testToken) {
    const headerToken = c.req.header('x-test-setup-token');
    if (headerToken !== testToken) {
      throw new HTTPException(403, { message: 'Invalid test setup token' });
    }
  }

  const { name } = (await c.req.json()) as { name?: string };
  const id = randomUUID();
  const email = `e2e-${id.slice(0, 8)}@example.com`;

  await query(
    `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, true, NOW(), NOW())`,
    [id, email, name ?? 'E2E Test User'],
  );

  const token = randomUUID();
  const sessionId = randomUUID();
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  const base64sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const signedToken = `${token}.${base64sig}`;

  await query(
    `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW(), NOW(), $3)`,
    [sessionId, token, id],
  );

  return c.json({ cookie: signedToken, userId: id });
});

export default router;
