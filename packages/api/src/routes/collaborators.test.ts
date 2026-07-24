import { describe, expect, it } from 'vitest';
import { createTestApp, createTestPage, createTestSession, createTestUser } from '../test-utils';

describe('collaborator display routes', () => {
  it('canonicalizes uppercase UUIDs before resolving and keying collaborators', async () => {
    const app = await createTestApp();
    const owner = await createTestUser();
    const session = await createTestSession(owner.id);
    const page = await createTestPage(owner.id);

    const response = await app.request(
      `/api/shares/pages/collaborators?ids=${page.id.toUpperCase()}`,
      { headers: { Cookie: session.Cookie } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, Array<{ userId: string }>>;
    expect(Object.keys(body)).toEqual([page.id]);
    expect(body[page.id]).toContainEqual(expect.objectContaining({ userId: owner.id }));
  });
});
