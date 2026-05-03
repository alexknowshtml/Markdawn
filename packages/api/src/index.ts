import './env';
import { serve } from '@hono/node-server';
import { honoLogger } from '@logtape/hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { timing } from 'hono/timing';
import { authRoutes } from './routes';
import backlinksRoute from './routes/backlinks';
import commentsRoute from './routes/comments';
import exportRoute from './routes/export';
import favoritesRoute from './routes/favorites';
import foldersRoute from './routes/folders';
import importRoute from './routes/import';
import obsidianImportRoute from './routes/obsidian-import';
import pagesRoute from './routes/pages';
import { publicRoute, publicShareRoute } from './routes/public';
import searchRoute from './routes/search';
import tagsRoute from './routes/tags';
import templatesRoute from './routes/templates';
import uploadsRoute from './routes/uploads';
import versionsRoute from './routes/versions';
import workspacesRoute from './routes/workspaces';

async function main() {
  const { setupLogger, getApiLogger } = await import('@markdawn/shared');
  await setupLogger();
  const appLogger = getApiLogger();

  type OriginDecision = string | undefined;

  const app = new Hono();

  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    '*',
    cors({
      origin: (origin: string | undefined): OriginDecision => {
        if (!isProduction) {
          return origin ?? '*';
        }
        if (!origin) {
          return allowedOrigins[0];
        }
        return allowedOrigins.includes(origin) ? origin : undefined;
      },
    }),
  );

  app.use(
    '*',
    honoLogger({
      category: ['markdawn', 'http'],
      skip: (c) => c.req.path === '/api/health',
    }),
  );
  app.use('*', timing());

  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: Date.now() });
  });

  app.route('/api/pages', pagesRoute);

  app.route('/api/folders', foldersRoute);

  app.route('/api/workspaces', workspacesRoute);

  app.route('/api/workspaces', exportRoute);

  app.route('/api/search', searchRoute);

  app.route('/api/favorites', favoritesRoute);

  app.route('/api/pages', commentsRoute);

  app.route('/api/pages', versionsRoute);

  app.route('/api/templates', templatesRoute);

  app.route('/api/uploads', uploadsRoute);
  app.route('/api/import', importRoute);
  app.route('/api/import/obsidian', obsidianImportRoute);
  app.route('/api/tags', tagsRoute);
  app.route('/api/backlinks', backlinksRoute);

  app.route('/api', publicRoute);

  app.route('/api', authRoutes);
  app.route('/api/pages', publicShareRoute);

  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    appLogger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  const port = Number(process.env.PORT ?? 3001);

  appLogger.info(`API server starting on port ${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}

main();

export type AppType = Hono;
