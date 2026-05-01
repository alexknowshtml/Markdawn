import { drizzle } from 'drizzle-orm/node-postgres';
import * as pg from 'pg';
const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";

// Uses PgBouncer (-pooler endpoint) — keep pool small to avoid double-pooling
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err.message);
});

export const db = drizzle(pool);
export { pool };
