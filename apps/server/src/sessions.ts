import { newSessionToken, sha256 } from "./crypto";
import type { Sql } from "./db";

/** A signed-in desktop app lasts 30 days from its last use. */
const SESSION_DAYS = 30;

/** Who is calling, from their session. */
export type Me = { sessionId: string; personId: string; tenantId: string; openId: string; name: string };

export async function createSession(sql: Sql, personId: string, device: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const [row] = await sql<{ expiresAt: Date }[]>`
    insert into sessions (person_id, token_hash, device, expires_at)
    values (${personId}, ${sha256(token)}, ${device}, now() + make_interval(days => ${SESSION_DAYS}))
    returning expires_at`;
  return { token, expiresAt: row!.expiresAt };
}

/**
 * The session behind a bearer token, extended when it was last used over an hour ago. Sessions in
 * a disabled company do not count: signing in again says why.
 */
export async function findSession(sql: Sql, token: string): Promise<Me | null> {
  const [row] = await sql<(Me & { lastUsedAt: Date })[]>`
    select s.id as session_id, s.person_id, s.last_used_at, p.tenant_id, p.open_id, p.name
    from sessions s join people p on p.id = s.person_id join tenants t on t.id = p.tenant_id
    where s.token_hash = ${sha256(token)} and s.revoked_at is null and s.expires_at > now() and t.disabled_at is null`;
  if (!row) return null;
  if (row.lastUsedAt.getTime() < Date.now() - 3_600_000) {
    await sql`update sessions set last_used_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS}) where id = ${row.sessionId}`;
  }
  const { lastUsedAt: _, ...me } = row;
  return me;
}

export async function revokeSession(sql: Sql, sessionId: string): Promise<void> {
  await sql`update sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`;
}
