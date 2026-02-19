import { createMiddleware } from "hono/factory";
import { auth } from "../auth";

type AuthUser = {
  id: string;
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const requireAuth = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = session.user as AuthUser;
  if (!user.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  await next();
  return;
});
