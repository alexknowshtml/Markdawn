import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendShareInviteEmail } from './email';

describe('sendShareInviteEmail', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports when delivery is disabled because SMTP is not configured', async () => {
    for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
      vi.stubEnv(name, '');
    }

    await expect(
      sendShareInviteEmail({
        to: 'recipient@example.com',
        entityTitle: 'Plan',
        entityType: 'page',
        sharedByName: 'Owner',
        permission: 'view',
        entityUrl: 'https://markdawn.example/page',
      }),
    ).resolves.toBe('disabled');
  });
});
