import { getAnonymousName } from '@markdawn/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../auth';
import { db } from '../db/connection';
import { executeQuery, type QueryExecutor } from '../db/query';
import { ensureFolderAccess, ensurePageAccess, type SharePermission } from './share-access';

const GUEST_COOKIE_NAME = 'markdawn_anon_id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestActor =
  | { kind: 'user'; id: string }
  | { kind: 'guest'; id: string; name: string };

function readGuestId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== GUEST_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(rawValue.join('='));
      return UUID_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function getRequestActor(c: Context): Promise<RequestActor> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = session?.user as { id?: string } | undefined;
  if (user?.id) return { kind: 'user', id: user.id };

  const guestId = readGuestId(c.req.header('cookie'));
  if (!guestId) {
    throw new HTTPException(401, { message: 'A guest identity is required' });
  }
  return { kind: 'guest', id: guestId, name: getAnonymousName(guestId) };
}

export async function persistGuestIdentity(
  actor: RequestActor,
  executor: QueryExecutor = db,
): Promise<void> {
  if (actor.kind !== 'guest') return;
  await executeQuery(
    executor,
    `insert into guest_identities (id, name, created_at, last_seen_at)
     values ($1, $2, now(), now())
     on conflict (id) do update set last_seen_at = excluded.last_seen_at`,
    [actor.id, actor.name],
  );
}

const permissionRank = (permission: SharePermission): number =>
  permission === 'admin' ? 3 : permission === 'edit' ? 2 : 1;

export async function ensureActorPageAccess(
  actor: RequestActor,
  pageId: string,
  mode: 'view' | 'edit' = 'view',
  executor: QueryExecutor = db,
): Promise<SharePermission> {
  if (actor.kind === 'user') {
    return (await ensurePageAccess(pageId, actor.id, mode, executor)).permission;
  }
  const result = await executeQuery<{ permission: SharePermission | null }>(
    executor,
    'select get_public_page_permission($1) as permission',
    [pageId],
  );
  const permission = result.rows[0]?.permission;
  if (!permission) {
    throw new HTTPException(404, { message: 'Page not found' });
  }
  if (permissionRank(permission) < permissionRank(mode)) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  return permission;
}

export async function ensureActorFolderAccess(
  actor: RequestActor,
  folderId: string,
  mode: 'view' | 'edit' = 'view',
  executor: QueryExecutor = db,
): Promise<SharePermission> {
  if (actor.kind === 'user') {
    return (await ensureFolderAccess(folderId, actor.id, mode, executor)).permission;
  }
  const result = await executeQuery<{ permission: SharePermission | null }>(
    executor,
    'select get_public_folder_permission($1) as permission',
    [folderId],
  );
  const permission = result.rows[0]?.permission;
  if (!permission) {
    throw new HTTPException(404, { message: 'Folder not found' });
  }
  if (permissionRank(permission) < permissionRank(mode)) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  return permission;
}

/** Edit grants creation without granting organization, deletion, or access management. */
export async function ensureActorCanCreateInFolder(
  actor: RequestActor,
  folderId: string,
  executor: QueryExecutor = db,
): Promise<void> {
  await ensureActorFolderAccess(actor, folderId, 'edit', executor);
}

export function actorColumns(actor: RequestActor): {
  userId: string | null;
  guestId: string | null;
} {
  return actor.kind === 'user'
    ? { userId: actor.id, guestId: null }
    : { userId: null, guestId: actor.id };
}
