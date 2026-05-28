import { createMiddleware } from 'hono/factory';
import { auth } from '../auth';

type AuthUser = {
  id: string;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const optionalAuth = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (session?.user) {
    const user = session.user as AuthUser;
    if (user.id) {
      c.set('user', user);
    }
  }

  await next();
  return;
});
