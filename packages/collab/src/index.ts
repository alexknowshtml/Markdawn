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

async function main() {
  const { setupLogger, getCollabLogger } = await import("@markdawn/shared");
  await setupLogger();
  const logger = getCollabLogger();

  const port = Number(process.env.COLLAB_PORT ?? "1234");
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for collab server");
  }

  const { Database } = await import("@hocuspocus/extension-database");
  const { Server } = await import("@hocuspocus/server");
  const { Pool } = await import("pg");
  const { applyUpdate, encodeStateAsUpdate } = await import("yjs");

  function getDbHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  const dbHostname = getDbHostname(databaseUrl);
  const isLocalDb = dbHostname === "localhost" || dbHostname === "127.0.0.1";

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: isLocalDb ? false : undefined,
  });

  pool.on("error", (err) => {
    logger.error(`Database pool error: ${err.message}`);
  });
  const SERVER_DEBOUNCE_MS = 500;
  const SERVER_MAX_DEBOUNCE_MS = 3000;

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
      const bearerTokenHeader = requestHeaders.authorization;
      const bearerMatch = bearerTokenHeader?.match(/^Bearer\s+(.+)$/i);
      const bearerToken = bearerMatch?.[1]?.trim() ?? "";
      const tokenFromParam = token?.trim() ?? "";
      const tokenFromCookie =
        cookies.get("better-auth.session_token")?.trim() ||
        cookies.get("__Secure-better-auth.session_token")?.trim() ||
        "";
      const sessionToken =
        tokenFromParam ||
        bearerToken ||
        tokenFromCookie ||
        "";

      if (!sessionToken) {
        logger.debug(`[auth] no session token provided`);
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
        logger.debug(`[auth] invalid/expired session`);
        throw new Error("Unauthorized");
      }

      logger.info(`[auth] authenticated user=${user.id} (${user.email})`);
      return { user };
    },
    onLoadDocument: async ({ documentName, document }) => {
      const result = await pool.query("select ydoc from pages where id = $1", [
        documentName,
      ]);

      const ydoc = result.rows[0]?.ydoc;
      if (!ydoc || ydoc.length === 0) {
        logger.info(`New document: ${documentName}`);
        return undefined;
      }

      logger.debug(`Loading document: ${documentName}, size: ${ydoc.length} bytes`);
      applyUpdate(document, new Uint8Array(ydoc));
    },
    onStoreDocument: async (data) => {
      const documentName = data.documentName;
      const state = encodeStateAsUpdate(data.document);
      if (!state || state.length === 0) {
        logger.debug(`[persist] skipping empty state: ${documentName}`);
        return;
      }

      logger.info(`[persist] saving: "${documentName}", size: ${state.length} bytes`);
      try {
        await pool.query("update pages set ydoc = $1, updated_at = NOW() where id = $2", [
          state,
          documentName,
        ]);
        logger.debug(`[persist] saved: ${documentName}`);
      } catch (err) {
        logger.error(`[persist] failed to save "${documentName}": ${err}`);
        throw err;
      }
    },
    onDisconnect: async ({ documentName, instance }) => {
      const doc = instance.documents.get(documentName);
      if (!doc) {
        return;
      }

      const state = encodeStateAsUpdate(doc);
      if (!state || state.length === 0) {
        return;
      }

      logger.info(`[disconnect] force saving: ${documentName}, ${state.length} bytes`);
      try {
        await pool.query("update pages set ydoc = $1, updated_at = NOW() where id = $2", [
          state,
          documentName,
        ]);
        logger.debug(`[disconnect] force saved: ${documentName}`);
      } catch (err) {
        logger.error(`[disconnect] force save failed for "${documentName}": ${err}`);
      }
    },
    extensions: [],
  });

  server.listen();
}

main();
