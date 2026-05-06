import { randomUUID } from 'node:crypto';
import { db } from '../db/connection';
import { workspaceMembers, workspaces } from '../db/schema';

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

export const getPersonalWorkspaceName = (name?: string | null, email?: string | null) => {
  const firstName = name?.trim()?.split(' ')?.[0] || email?.split('@')?.[0] || 'Personal';
  return firstName.length > 0 ? `${firstName}'s Workspace` : 'Personal Workspace';
};

export const buildWorkspaceSlug = async (
  name: string,
  pool: {
    query: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
  },
) => {
  const baseSlug = slugify(name) || 'personal';
  let slug = baseSlug;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await pool.query('select id from workspaces where slug = $1 limit 1', [slug]);

    if (existing.rowCount === 0) {
      return slug;
    }

    slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
  }

  return `${baseSlug}-${randomUUID().slice(0, 8)}`;
};

export const ensurePersonalWorkspace = async ({
  userId,
  name,
  email,
  pool,
}: {
  userId: string;
  name?: string | null;
  email?: string | null;
  pool: {
    query: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
  };
}) => {
  const workspaceName = getPersonalWorkspaceName(name, email);
  const slug = await buildWorkspaceSlug(workspaceName, pool);

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
    role: 'owner',
  });
};
