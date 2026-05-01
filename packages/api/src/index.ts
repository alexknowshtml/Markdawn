import "./env";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { timing } from "hono/timing";
import { readFileSync } from "fs";
import { honoLogger } from "@logtape/hono";
import pagesRoute from "./routes/pages";
import workspacesRoute from "./routes/workspaces";
import searchRoute from "./routes/search";
import favoritesRoute from "./routes/favorites";
import commentsRoute from "./routes/comments";
import versionsRoute from "./routes/versions";
import { publicRoute, publicShareRoute } from "./routes/public";
import { authRoutes } from "./routes";
import templatesRoute from "./routes/templates";
import exportRoute from "./routes/export";
import uploadsRoute from "./routes/uploads";
import foldersRoute from "./routes/folders";
import importRoute from "./routes/import";
import obsidianImportRoute from "./routes/obsidian-import";
import tagsRoute from "./routes/tags";
import backlinksRoute from "./routes/backlinks";

async function main() {
  const { setupLogger, getApiLogger } = await import("@markdawn/shared");
  await setupLogger();
  const appLogger = getApiLogger();

  type OriginDecision = string | undefined;

  const app = new Hono();

  const isProduction = process.env.NODE_ENV === "production";
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    "*",
    cors({
      origin: (origin: string | undefined): OriginDecision => {
        if (!isProduction) {
          return origin ?? "*";
        }
        if (!origin) {
          return allowedOrigins[0];
        }
        return allowedOrigins.includes(origin) ? origin : undefined;
      },
    })
  );

  app.use("*", honoLogger({
    category: ["markdawn", "http"],
    skip: (c) => c.req.path === "/api/health",
  }));
  app.use("*", timing());

  app.get("/api/health", (c) => {
    return c.json({ status: "ok", timestamp: Date.now() });
  });

  app.route("/api/pages", pagesRoute);

  app.route("/api/folders", foldersRoute);

  app.route("/api/workspaces", workspacesRoute);

  app.route("/api/workspaces", exportRoute);

  app.route("/api/search", searchRoute);

  app.route("/api/favorites", favoritesRoute);

  app.route("/api/pages", commentsRoute);

  app.route("/api/pages", versionsRoute);

  app.route("/api/templates", templatesRoute);

  app.route("/api/uploads", uploadsRoute);
  app.route("/api/import", importRoute);
  app.route("/api/import/obsidian", obsidianImportRoute);
  app.route("/api/tags", tagsRoute);
  app.route("/api/backlinks", backlinksRoute);

  app.route("/api", publicRoute);

  app.route("/api", authRoutes);
  app.route("/api/pages", publicShareRoute);

  if (isProduction) {
    app.use('/assets/*', serveStatic({ root: './dist/web' }));
    app.all('*', (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.notFound();
      }
      const html = readFileSync('./dist/web/index.html', 'utf-8');
      return c.html(html);
    });
  }

  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    appLogger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    return c.json({ error: "Internal Server Error" }, 500);
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