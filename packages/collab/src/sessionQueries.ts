import type { Pool } from 'pg';

export type SessionCandidate = { userId: string; sessionToken: string };
export type SessionState = { valid: boolean; accessRevision: string };
type SessionQueryExecutor = Pick<Pool, 'query'>;

export type AuthenticatedSession = {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  };
  accessRevision: string;
};

export function sessionKey(candidate: SessionCandidate): string {
  return `${candidate.userId}:${candidate.sessionToken}`;
}

export async function querySessionStates(
  executor: SessionQueryExecutor,
  candidates: readonly SessionCandidate[],
): Promise<Map<string, SessionState>> {
  if (candidates.length === 0) return new Map();
  const result = await executor.query<{
    user_id: string;
    session_token: string;
    valid: boolean;
    access_revision: string;
  }>(
    `with requested as (
       select distinct *
       from unnest($1::uuid[], $2::text[]) as item(user_id, session_token)
     )
     select requested.user_id, requested.session_token,
            is_active_session(requested.user_id, requested.session_token) as valid,
            coalesce((select max(version) from workspace_access_versions), 0)::text as access_revision
     from requested`,
    [
      candidates.map((candidate) => candidate.userId),
      candidates.map((candidate) => candidate.sessionToken),
    ],
  );
  return new Map(
    result.rows.map((row) => [
      sessionKey({ userId: row.user_id, sessionToken: row.session_token }),
      { valid: row.valid, accessRevision: row.access_revision },
    ]),
  );
}

export async function querySessionState(
  executor: SessionQueryExecutor,
  candidate: SessionCandidate,
): Promise<SessionState | undefined> {
  return (await querySessionStates(executor, [candidate])).get(sessionKey(candidate));
}

export async function queryAuthenticatedSession(
  executor: SessionQueryExecutor,
  sessionToken: string,
): Promise<AuthenticatedSession | undefined> {
  const result = await executor.query<{
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    accessRevision: string;
  }>(
    `select users.id, users.email, users.name,
            users.image as "avatarUrl",
            coalesce((select max(version) from workspace_access_versions), 0)::text as "accessRevision"
     from sessions
     join users on users.id = sessions.user_id
     where sessions.token = $1
       and is_active_session(sessions.user_id, sessions.token)
     limit 1`,
    [sessionToken],
  );
  const user = result.rows[0];
  if (!user) return undefined;
  return {
    token: sessionToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
    accessRevision: user.accessRevision,
  };
}
