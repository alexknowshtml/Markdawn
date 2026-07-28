import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { Resend } from 'resend';
import { db } from './db';
import { accounts, sessions, users, verifications } from './db/schema';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM ?? 'noreply@stackingthebricks.com';

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
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: user.email,
        subject: 'Reset your password — Stacking the Bricks',
        html: `<p>Hi ${user.name || user.email},</p><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${url}">Reset password</a></p><p>If you didn't request this, ignore this email.</p>`,
      });
    },
  },
});
