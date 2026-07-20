import { afterEach, describe, expect, it, vi } from 'vitest';
import { testQuery as query } from '../db/testQuery';
import { createTestApp } from '../test-utils';

describe('POST /api/test/setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed when the test setup token is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TEST_SETUP_TOKEN', '');
    const app = await createTestApp();

    const res = await app.request('/api/test/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unexpected User' }),
    });

    expect(res.status).toBe(403);
    const users = await query('SELECT id FROM users');
    expect(users.rowCount).toBe(0);
  });

  it('creates a test session only with the configured token', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TEST_SETUP_TOKEN', 'configured-test-token');
    const app = await createTestApp();

    const denied = await app.request('/api/test/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Denied User' }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/api/test/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-setup-token': 'configured-test-token',
      },
      body: JSON.stringify({ name: 'Playwright User' }),
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      cookie: expect.any(String),
      userId: expect.any(String),
    });
  });

  it('stays disabled in production even when a token is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEST_SETUP_TOKEN', 'configured-test-token');
    const app = await createTestApp();

    const res = await app.request('/api/test/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-setup-token': 'configured-test-token',
      },
      body: JSON.stringify({ name: 'Unexpected User' }),
    });

    expect(res.status).toBe(403);
  });
});
