import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { pool } from './db';
import { db } from './db';
import { accounts, sessions, users, verifications } from './db/schema';
import { ensurePersonalWorkspace } from './utils/auth-helpers';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

export const auth = betterAuth({
  baseURL: FRONTEND_URL,
  trustedOrigins: [FRONTEND_URL],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  advanced: {
    database: {
      generateId: false,
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensurePersonalWorkspace({
            userId: user.id,
            name: user.name,
            email: user.email,
            pool,
          });
        },
      },
    },
  },
});
