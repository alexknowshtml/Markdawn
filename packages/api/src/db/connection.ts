import { drizzle } from 'drizzle-orm/node-postgres';
import * as pg from 'pg';
const { Pool } = pg;

function getDbHostname(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const dbHostname = getDbHostname(process.env.DATABASE_URL);
const isLocalDb = dbHostname === "localhost" || dbHostname === "127.0.0.1";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: isLocalDb ? false : undefined,
});

pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err.message);
});

export const db = drizzle(pool);
export { pool };
