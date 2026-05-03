import { describe, expect, it } from 'vitest';
import { createTestApp } from '../test-utils';

describe('export API', () => {
  describe('auth guard', () => {
    it('returns 401 without session cookie', async () => {
      const app = await createTestApp();
      const res = await app.request('/api/workspaces/some-ws-id/export');
      expect(res.status).toBe(401);
    });
  });
});
