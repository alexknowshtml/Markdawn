import { bench, describe } from 'vitest';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';

describe('search API benchmarks', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let session: Awaited<ReturnType<typeof createTestSession>>;
  let workspaceId: string;

  bench(
    'search with 50 pages',
    async () => {
      await app.request(`/api/search?q=Document&workspaceId=${workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });
    },
    {
      setup: async () => {
        app = await createTestApp();
        const user = await createTestUser();
        session = await createTestSession(user.id);
        workspaceId = user.workspaceId;

        for (let i = 0; i < 50; i++) {
          await createTestPage(workspaceId, user.id, { title: `Document ${i}` });
        }
      },
      iterations: 10,
      time: 1000,
    },
  );
});
