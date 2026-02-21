import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { pool } from "./db";
import { randomUUID } from "crypto";
import { db } from "./db";
import { users, sessions, accounts, verifications, workspaces, workspaceMembers } from "./db/schema";

const FRONTEND_URL = process.env.FRONTEND_URL ?? process.env.BASE_URL ?? "http://localhost:5173";

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

const getPersonalWorkspaceName = (name?: string | null, email?: string | null) => {
  const firstName = name?.trim()?.split(" ")?.[0] || email?.split("@")?.[0] || "Personal";
  return firstName.length > 0 ? `${firstName}'s Workspace` : "Personal Workspace";
};

const buildWorkspaceSlug = async (name: string) => {
  const baseSlug = slugify(name) || "personal";
  let slug = baseSlug;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await pool.query("select id from workspaces where slug = $1 limit 1", [slug]);

    if (existing.rowCount === 0) {
      return slug;
    }

    slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
  }

  return `${baseSlug}-${randomUUID().slice(0, 8)}`;
};

const ensurePersonalWorkspace = async ({
  userId,
  name,
  email,
}: {
  userId: string;
  name?: string | null;
  email?: string | null;
}) => {
  const workspaceName = getPersonalWorkspaceName(name, email);
  const slug = await buildWorkspaceSlug(workspaceName);

  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: workspaceName,
      slug,
      ownerId: userId,
      isPersonal: true,
    })
    .returning({ id: workspaces.id });

  if (!workspace) {
    return;
  }

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId,
    role: "owner",
  });
};

export const auth = betterAuth({
  baseURL: FRONTEND_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
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
          });
        },
      },
    },
  },
});
