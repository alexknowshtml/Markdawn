import { bench, describe } from 'vitest';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';

describe('search API benchmarks', () => {
  bench(
    'search with 50 pages',
    async ({ app, session, workspaceId }: { app: Awaited<ReturnType<typeof createTestApp>>; session: Awaited<ReturnType<typeof createTestSession>>; workspaceId: string }) => {
      await app.request(`/api/search?q=Document&workspaceId=${workspaceId}`, {
        headers: { Cookie: session.Cookie },
      });
    },
    {
      setup: async () => {
        const app = await createTestApp();
        const user = await createTestUser();
        const session = await createTestSession(user.id);

        for (let i = 0; i < 50; i++) {
          await createTestPage(user.workspaceId, user.id, { title: `Document ${i}` });
        }

        return { app, session, workspaceId: user.workspaceId };
      },
      iterations: 10,
      time: 1000,
    },
  );
});
