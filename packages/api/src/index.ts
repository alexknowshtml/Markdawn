import './env';
import { serve } from '@hono/node-server';
import { createApp } from './app';

async function main() {
  const app = await createApp();

  const port = Number(process.env.PORT ?? 3001);

  serve({
    fetch: app.fetch,
    port,
  });
}

main();

export type { AppType } from './app';

export { createApp } from './app';
