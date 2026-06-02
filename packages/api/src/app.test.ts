import { describe, expect, it } from 'vitest';
import { createTestApp } from './test-utils';

async function setup() {
  const app = await createTestApp();
  app.get('/api/trigger-error', () => {
    throw new Error('unhandled test error');
  });
  return app;
}

describe('App shell', () => {
  describe('GET /api/health', () => {
    it('returns status ok', async () => {
      const app = await setup();
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toEqual(expect.any(Number));
    });
  });

  describe('CORS', () => {
    it('returns CORS headers in dev mode for allowed origin', async () => {
      const app = await setup();
      const res = await app.request('/api/health', {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('responds to OPTIONS preflight', async () => {
      const app = await setup();
      const res = await app.request('/api/health', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(res.status).toBe(204);
    });

    it('enforces allowlist in production', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalCorsOrigins = process.env.CORS_ORIGINS;
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://app.example.com';

      const app = await createTestApp();
      const allowed = await app.request('/api/health', {
        headers: { Origin: 'https://app.example.com' },
      });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');

      const blocked = await app.request('/api/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(blocked.headers.get('access-control-allow-origin')).toBeNull();

      process.env.NODE_ENV = originalNodeEnv;
      process.env.CORS_ORIGINS = originalCorsOrigins;
    });
  });

  describe('404 handler', () => {
    it('returns 404 for unknown routes', async () => {
      const app = await setup();
      const res = await app.request('/api/nonexistent');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ message: 'Not Found' });
    });

    it('returns 404 for nested unknown routes', async () => {
      const app = await setup();
      const res = await app.request('/api/unknown/deep/nested');
      expect(res.status).toBe(404);
    });
  });

  describe('global error handler', () => {
    it('returns 500 for unhandled errors and does not leak stack', async () => {
      const app = await setup();
      const res = await app.request('/api/trigger-error');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ message: 'Internal Server Error' });
      expect(JSON.stringify(body)).not.toContain('stack');
    });

    it('returns proper status for HTTPException', async () => {
      const app = await setup();
      const res = await app.request('/api/pages/tree');
      expect(res.status).toBe(401);
    });
  });

  describe('timing header', () => {
    it('does not crash when timing middleware is registered', async () => {
      const app = await setup();
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    });
  });
});
