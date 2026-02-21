import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));

const candidateEnvPaths = [
  resolve(process.cwd(), ".env"),
  resolve(currentDir, "../.env"),
  resolve(currentDir, "../../../.env"),
];

const selectedEnvPath = candidateEnvPaths.find((envPath) => existsSync(envPath));

if (selectedEnvPath) {
  config({ path: selectedEnvPath });
} else {
  config();
}

import { Database } from "@hocuspocus/extension-database";
import { Logger } from "@hocuspocus/extension-logger";
import { Server } from "@hocuspocus/server";
import { Pool } from "pg";

const port = Number(process.env.COLLAB_PORT ?? "1234");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for collab server");
}

const pool = new Pool({ connectionString: databaseUrl });
const SERVER_DEBOUNCE_MS = 1500;
const SERVER_MAX_DEBOUNCE_MS = 10000;

const parseCookies = (cookieHeader?: string) => {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  const cookies = new Map<string, string>();
  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValueParts] = cookie.split("=");
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }

    const value = rawValueParts.join("=").trim();
    if (!value) {
      continue;
    }

    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }

  return cookies;
};

const server = new Server({
  port,
  debounce: SERVER_DEBOUNCE_MS,
  maxDebounce: SERVER_MAX_DEBOUNCE_MS,
  onAuthenticate: async ({ token, requestHeaders }) => {
    const cookies = parseCookies(requestHeaders.cookie);
    const sessionToken =
      token ||
      cookies.get("better-auth.session_token") ||
      cookies.get("__Secure-better-auth.session_token") ||
      "";

    if (!sessionToken) {
      throw new Error("Unauthorized");
    }

    const result = await pool.query(
      `select users.id, users.email, users.name, users.avatar_url as "avatarUrl"
       from sessions
       join users on users.id = sessions.user_id
       where sessions.token = $1 and sessions.expires_at > NOW()
       limit 1`,
      [sessionToken],
    );

    const user = result.rows[0];
    if (!user) {
      throw new Error("Unauthorized");
    }

    return { user };
  },
  extensions: [
    new Logger(),
    new Database({
      fetch: async ({ documentName }) => {
        const result = await pool.query("select ydoc from pages where id = $1", [
          documentName,
        ]);

        return result.rows[0]?.ydoc ?? null;
      },
      store: async ({ documentName, state }) => {
        await pool.query("update pages set ydoc = $1, updated_at = NOW() where id = $2", [
          state,
          documentName,
        ]);
      },
    }),
  ],
});

server.listen();
