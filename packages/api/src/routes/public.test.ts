import { describe, expect, it } from 'vitest';
import { createTestApp } from '../test-utils';

describe('public sharing API', () => {
  describe('auth guard', () => {
    it('returns 401 on share endpoint without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/pages/some-page-id/share', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('public access', () => {
    it('allows unauthenticated access to public token endpoint', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/public/some-token');
      expect(res.status).toBe(404);
    });
  });
});
