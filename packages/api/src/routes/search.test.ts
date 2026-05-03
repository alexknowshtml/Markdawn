import { describe, expect, it } from 'vitest';
import { createTestApp } from '../test-utils';

describe('search API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/search?q=test');
      expect(res.status).toBe(401);
    });
  });
});
