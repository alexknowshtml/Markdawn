import { Database } from "@hocuspocus/extension-database";
import { Logger } from "@hocuspocus/extension-logger";
import { Server } from "@hocuspocus/server";
import { Pool } from "pg";

const port = Number(process.env.COLLAB_PORT ?? "1234");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const server = new Server({
  port,
  onAuthenticate: async ({ token }) => {
    if (!token) {
      throw new Error("Unauthorized");
    }

    const result = await pool.query(
      `select users.id, users.email, users.name, users.avatar_url as "avatarUrl"
       from session
       join users on users.id = session."userId"
       where session.token = $1 and session."expiresAt" > NOW()
       limit 1`,
      [token],
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
