import { Hono } from 'hono';
import { auth } from '../auth';

const router = new Hono();

router.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

export { router as authRoutes };
