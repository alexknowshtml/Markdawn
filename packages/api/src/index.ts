import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import pagesRoute from "./routes/pages";
import workspacesRoute from "./routes/workspaces";
import searchRoute from "./routes/search";
import { authRoutes } from "./routes";

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
        return undefined;
      }
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
  })
);

app.use("*", logger());
app.use("*", timing());

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

app.route("/api/pages", pagesRoute);

app.route("/api/workspaces", workspacesRoute);

app.route("/api/search", searchRoute);

app.route("/api", authRoutes);

app.notFound((c) => c.json({ error: "Not Found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  return c.json({ error: "Internal Server Error" }, 500);
});

const port = Number(process.env.PORT ?? 3001);

serve({
  fetch: app.fetch,
  port,
});

export type AppType = typeof app;
