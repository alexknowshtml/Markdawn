import './env';
import { serve } from '@hono/node-server';
import { getApiLogger } from '@markdawn/shared';
import { createApp } from './app';
import { drainExpiredGuestIdentities } from './utils/guestIdentityCleanup';
import { processUploadDeletionQueue } from './utils/uploadCleanup';

async function main() {
  const app = await createApp();

  await processUploadDeletionQueue();
  let guestCleanupTask: Promise<void> | null = null;
  const runGuestCleanup = () => {
    if (guestCleanupTask) return;
    guestCleanupTask = drainExpiredGuestIdentities()
      .then((deleted) => {
        if (deleted > 0)
          getApiLogger().info('Expired guest identity cleanup completed', { deleted });
      })
      .catch((error: unknown) => {
        getApiLogger().error('Guest identity cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        guestCleanupTask = null;
      });
  };
  const uploadCleanupTimer = setInterval(() => {
    void processUploadDeletionQueue().catch((error: unknown) => {
      getApiLogger().error('Upload deletion queue drain failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 60_000);
  uploadCleanupTimer.unref();

  const guestCleanupTimer = setInterval(runGuestCleanup, 24 * 60 * 60 * 1000);
  guestCleanupTimer.unref();

  const port = Number(process.env.PORT ?? 3001);

  serve({
    fetch: app.fetch,
    port,
  });

  const initialGuestCleanup = setTimeout(runGuestCleanup, 0);
  initialGuestCleanup.unref();
}

main();

export type { AppType } from './app';

export { createApp } from './app';
