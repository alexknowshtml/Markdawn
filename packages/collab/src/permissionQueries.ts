import type { SharePermission } from '@markdawn/shared';
import type { Pool } from 'pg';
import type { PermissionState } from './permissionState';

type PermissionQueryExecutor = Pick<Pool, 'query'>;

export type PagePermissionCandidate = {
  pageId: string;
  userId: string;
};

export type SessionPagePermissionCandidate = PagePermissionCandidate & {
  sessionToken: string;
};

export type PrincipalPagePermissionCandidate =
  | ({ kind: 'account' } & PagePermissionCandidate)
  | ({ kind: 'session' } & SessionPagePermissionCandidate)
  | { kind: 'anonymous'; pageId: string };

function normalizePermission(permission: string | null): SharePermission | null {
  return permission === 'admin' || permission === 'edit' || permission === 'view'
    ? permission
    : null;
}

export function accountPagePermissionKey(candidate: PagePermissionCandidate): string {
  return `${candidate.pageId}:${candidate.userId}`;
}

export function sessionPagePermissionKey(candidate: SessionPagePermissionCandidate): string {
  return `${accountPagePermissionKey(candidate)}:${candidate.sessionToken}`;
}

export function principalPagePermissionKey(candidate: PrincipalPagePermissionCandidate): string {
  if (candidate.kind === 'anonymous') return `anonymous:${candidate.pageId}`;
  if (candidate.kind === 'account') return `account:${accountPagePermissionKey(candidate)}`;
  return `session:${sessionPagePermissionKey(candidate)}`;
}

export async function queryAccountPagePermissions(
  pool: PermissionQueryExecutor,
  candidates: readonly PagePermissionCandidate[],
): Promise<Map<string, PermissionState>> {
  if (candidates.length === 0) return new Map();
  const result = await pool.query<{
    page_id: string;
    user_id: string;
    permission: string | null;
    access_revision: string;
  }>(
    `WITH requested_users AS (
       select distinct *
       from unnest($1::uuid[], $2::uuid[]) as candidate(page_id, user_id)
     )
     select requested_users.page_id, requested_users.user_id,
            access.permission,
            get_page_access_revision(requested_users.page_id)::text as access_revision
     from requested_users
     left join lateral get_effective_page_permission(
       requested_users.page_id,
       requested_users.user_id
     ) access on true`,
    [
      candidates.map((candidate) => candidate.pageId),
      candidates.map((candidate) => candidate.userId),
    ],
  );
  return new Map(
    result.rows.map((row) => [
      accountPagePermissionKey({ pageId: row.page_id, userId: row.user_id }),
      {
        permission: normalizePermission(row.permission),
        accessRevision: row.access_revision,
      },
    ]),
  );
}

export async function querySessionPagePermissions(
  pool: PermissionQueryExecutor,
  candidates: readonly SessionPagePermissionCandidate[],
): Promise<Map<string, PermissionState>> {
  if (candidates.length === 0) return new Map();
  const result = await pool.query<{
    page_id: string;
    user_id: string;
    session_token: string;
    permission: string | null;
    access_revision: string;
  }>(
    `WITH requested_users AS (
       select distinct *
       from unnest($1::uuid[], $2::uuid[], $3::text[])
         as candidate(page_id, user_id, session_token)
     )
     select requested_users.page_id, requested_users.user_id,
            requested_users.session_token,
            case when is_active_session(
              requested_users.user_id,
              requested_users.session_token
            ) then access.permission else null end as permission,
            get_page_access_revision(requested_users.page_id)::text as access_revision
     from requested_users
     left join lateral get_effective_page_permission(
       requested_users.page_id,
       requested_users.user_id
     ) access on true`,
    [
      candidates.map((candidate) => candidate.pageId),
      candidates.map((candidate) => candidate.userId),
      candidates.map((candidate) => candidate.sessionToken),
    ],
  );
  return new Map(
    result.rows.map((row) => [
      sessionPagePermissionKey({
        pageId: row.page_id,
        userId: row.user_id,
        sessionToken: row.session_token,
      }),
      {
        permission: normalizePermission(row.permission),
        accessRevision: row.access_revision,
      },
    ]),
  );
}

export async function queryAnonymousPagePermissions(
  pool: PermissionQueryExecutor,
  pageIds: readonly string[],
): Promise<Map<string, PermissionState>> {
  if (pageIds.length === 0) return new Map();
  const result = await pool.query<{
    page_id: string;
    permission: string | null;
    access_revision: string;
  }>(
    `with requested as (
       select distinct unnest($1::uuid[]) as page_id
     )
     select requested.page_id, get_public_page_permission(requested.page_id) as permission,
            get_page_access_revision(requested.page_id)::text as access_revision
     from requested`,
    [pageIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.page_id,
      {
        permission: normalizePermission(row.permission),
        accessRevision: row.access_revision,
      },
    ]),
  );
}

export async function queryPrincipalPagePermissions(
  pool: PermissionQueryExecutor,
  candidates: readonly PrincipalPagePermissionCandidate[],
): Promise<Map<string, PermissionState>> {
  const accounts = candidates.filter(
    (candidate): candidate is Extract<PrincipalPagePermissionCandidate, { kind: 'account' }> =>
      candidate.kind === 'account',
  );
  const sessions = candidates.filter(
    (candidate): candidate is Extract<PrincipalPagePermissionCandidate, { kind: 'session' }> =>
      candidate.kind === 'session',
  );
  const anonymousPageIds = candidates.flatMap((candidate) =>
    candidate.kind === 'anonymous' ? [candidate.pageId] : [],
  );
  const [accountStates, sessionStates, anonymousStates] = await Promise.all([
    queryAccountPagePermissions(pool, accounts),
    querySessionPagePermissions(pool, sessions),
    queryAnonymousPagePermissions(pool, anonymousPageIds),
  ]);
  const result = new Map<string, PermissionState>();
  for (const candidate of candidates) {
    const state =
      candidate.kind === 'anonymous'
        ? anonymousStates.get(candidate.pageId)
        : candidate.kind === 'account'
          ? accountStates.get(accountPagePermissionKey(candidate))
          : sessionStates.get(sessionPagePermissionKey(candidate));
    if (state) result.set(principalPagePermissionKey(candidate), state);
  }
  return result;
}
