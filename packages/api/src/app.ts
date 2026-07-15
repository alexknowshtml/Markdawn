import './env';
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
import foldersRoute, { foldersPublicRoute } from './routes/folders';
import importRoute from './routes/import';
import obsidianImportRoute from './routes/obsidian-import';
import pagesRoute, { pagesPublicRoute } from './routes/pages';
import searchRoute from './routes/search';
import sharesRoute from './routes/shares';
import tagsRoute from './routes/tags';
import templatesRoute from './routes/templates';
import testSetupRoute from './routes/test-setup';
import uploadsRoute from './routes/uploads';
import versionsRoute from './routes/versions';
import workspaceRoute from './routes/workspace';

export async function createApp() {
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

  app.route('/api/pages', pagesPublicRoute);
  app.route('/api/pages', exportRoute);
  app.route('/api/pages', pagesRoute);

  app.route('/api/folders', foldersPublicRoute);
  app.route('/api/folders', foldersRoute);

  // workspaces API removed

  app.route('/api/search', searchRoute);

  app.route('/api/shares', sharesRoute);

  app.route('/api/favorites', favoritesRoute);

  app.route('/api/pages', commentsRoute);

  app.route('/api/pages', versionsRoute);

  app.route('/api/templates', templatesRoute);

  app.route('/api/uploads', uploadsRoute);
  app.route('/api/import', importRoute);
  app.route('/api/import/obsidian', obsidianImportRoute);
  app.route('/api/tags', tagsRoute);
  app.route('/api/backlinks', backlinksRoute);

  app.route('/api/workspace', workspaceRoute);

  app.route('/api', testSetupRoute);

  // Legacy /api/public routes removed — public pages are now served at /api/pages/:id
  app.route('/api', authRoutes);

  app.notFound((c) => c.json({ message: 'Not Found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = err.cause;
      const code =
        cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
          ? cause.code
          : undefined;
      return c.json(code ? { message: err.message, code } : { message: err.message }, err.status);
    }
    appLogger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    return c.json({ message: 'Internal Server Error' }, 500);
  });

  return app;
}

export type AppType = Hono;
