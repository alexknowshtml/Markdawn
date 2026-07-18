import './env';
import { serve } from '@hono/node-server';
import { getApiLogger } from '@markdawn/shared';
import { createApp } from './app';
import { processUploadDeletionQueue } from './utils/uploadCleanup';

async function main() {
  const app = await createApp();

  await processUploadDeletionQueue();
  const uploadCleanupTimer = setInterval(() => {
    void processUploadDeletionQueue().catch((error: unknown) => {
      getApiLogger().error('Upload deletion queue drain failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 60_000);
  uploadCleanupTimer.unref();

  const port = Number(process.env.PORT ?? 3001);

  serve({
    fetch: app.fetch,
    port,
  });
}

main();

export type { AppType } from './app';

export { createApp } from './app';
