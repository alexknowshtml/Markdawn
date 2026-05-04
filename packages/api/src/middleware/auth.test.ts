import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import '../env';
import { createTestSession, createTestUser } from '../test-utils';
import { requireAuth } from './auth';

function createTestMiddlewareApp() {
  const app = new Hono();
  app.use('*', requireAuth);
  app.get('/test', (c) => c.json({ userId: c.get('user').id }));
  return app;
}

describe('requireAuth middleware', () => {
  it('returns 401 when no session cookie is present', async () => {
    const app = createTestMiddlewareApp();
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with an invalid session token', async () => {
    const app = createTestMiddlewareApp();
    const res = await app.request('/test', {
      headers: { Cookie: 'better-auth.session_token=not-a-valid-uuid' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed cookie', async () => {
    const app = createTestMiddlewareApp();
    const res = await app.request('/test', {
      headers: { Cookie: 'garbage-cookie-value' },
    });
    expect(res.status).toBe(401);
  });

  it('sets user context and calls next for valid session', async () => {
    const app = createTestMiddlewareApp();
    const user = await createTestUser();
    const session = await createTestSession(user.id);

    const res = await app.request('/test', {
      headers: {
        Cookie: session.Cookie,
        Origin: 'http://localhost:5173',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(user.id);
  });

  it('returns 401 when session token does not exist', async () => {
    const app = createTestMiddlewareApp();
    const res = await app.request('/test', {
      headers: {
        Cookie: 'better-auth.session_token=nonexistent-token',
        Origin: 'http://localhost:5173',
      },
    });
    expect(res.status).toBe(401);
  });
});
