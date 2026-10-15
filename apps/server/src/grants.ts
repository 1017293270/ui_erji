import type { Companies } from "./companies";
import { seal, unseal } from "./crypto";
import type { Sql } from "./db";
import { FeishuError } from "./feishu/client";
import { OAuthRejected, refreshTokens, type Tokens } from "./feishu/oauth";
import { log } from "./log";

/**
 * People's Feishu user tokens, sealed in feishu_grants. EchoMind acts as the person who recorded
 * a meeting (their tasks, their calendar) long after their computer is off, so the server keeps
 * the refresh token alive. Refresh tokens are single-use: every refresh holds the row lock.
 */

/** The person has to sign in to Feishu again: their grant is gone or Feishu refused it. */
export class SignedOut extends Error {
  constructor() {
    super("飞书授权已失效：请在 EchoMind 里重新用飞书登录。");
  }
}

export type GrantDeps = { sql: Sql; companies: Companies; key: Buffer | null };
export type UserToken = { accessToken: string; openId: string };

type Row = {
  personId: string;
  openId: string;
  accessToken: Uint8Array;
  accessExpiresAt: Date;
  refreshToken: Uint8Array | null;
  refreshExpiresAt: Date | null;
  updatedAt: Date;
  revokedAt: Date | null;
};

const MINUTE = 60_000;

function needKey(deps: GrantDeps): Buffer {
  if (!deps.key) throw new Error("服务器还没有配置 ECHOMIND_DATA_KEY，不能保存飞书授权：请管理员处理。");
  return deps.key;
}

const aad = (personId: string, kind: "access" | "refresh") => `${personId}:${kind}`;

export async function storeGrant(deps: GrantDeps, personId: string, tokens: Tokens): Promise<void> {
  const key = needKey(deps);
  const access = seal(key, tokens.accessToken, aad(personId, "access"));
  const refresh = tokens.refreshToken ? seal(key, tokens.refreshToken, aad(personId, "refresh")) : null;
  await deps.sql`
    insert into feishu_grants (person_id, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes, updated_at, revoked_at)
    values (${personId}, ${access}, ${tokens.accessExpiresAt}, ${refresh}, ${tokens.refreshExpiresAt}, ${tokens.scopes ?? ""}, now(), null)
    on conflict (person_id) do update set
      access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
      refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
      scopes = excluded.scopes, updated_at = now(), revoked_at = null`;
}

const select = (sql: Sql, personId: string) => sql<Row[]>`
  select g.person_id, p.open_id, g.access_token, g.access_expires_at, g.refresh_token, g.refresh_expires_at, g.updated_at, g.revoked_at
  from feishu_grants g join people p on p.id = g.person_id
  where g.person_id = ${personId}`;

/** Why a refresh happens, which decides whether one done meanwhile by someone else will do. */
type Reason = { kind: "expiring" } | { kind: "rejected"; token: string } | { kind: "keepalive" };

async function refresh(deps: GrantDeps, personId: string, reason: Reason): Promise<UserToken> {
  const key = needKey(deps);
  // The company's client is looked up before the transaction: inside it, waiting for a second
  // connection while holding the row lock can starve the pool when many refresh at once.
  const [person] = await deps.sql<{ tenantId: string }[]>`select tenant_id from people where id = ${personId}`;
  if (!person) throw new SignedOut();
  const feishu = await deps.companies.feishu(person.tenantId);
  const outcome = await deps.sql.begin(async (tx) => {
    const [g] = await tx<Row[]>`
      select g.person_id, p.open_id, g.access_token, g.access_expires_at, g.refresh_token, g.refresh_expires_at, g.updated_at, g.revoked_at
      from feishu_grants g join people p on p.id = g.person_id
      where g.person_id = ${personId} for update of g`;
    if (!g || g.revokedAt) return null;
    const current = unseal(key, g.accessToken, aad(personId, "access"));
    const now = Date.now();
    const fresh = g.accessExpiresAt.getTime() > now + 5 * MINUTE;
    // Someone refreshed while we waited for the lock.
    if (reason.kind === "expiring" && fresh) return { accessToken: current, openId: g.openId };
    if (reason.kind === "rejected" && current !== reason.token) return { accessToken: current, openId: g.openId };
    if (reason.kind === "keepalive" && g.updatedAt.getTime() > now - 20 * 60 * MINUTE) return { accessToken: current, openId: g.openId };

    const refreshToken =
      g.refreshToken && (!g.refreshExpiresAt || g.refreshExpiresAt.getTime() > now) ? unseal(key, g.refreshToken, aad(personId, "refresh")) : null;
    if (!refreshToken) {
      await tx`update feishu_grants set revoked_at = now() where person_id = ${personId}`;
      return null;
    }
    let tokens: Tokens;
    try {
      tokens = await refreshTokens(feishu, refreshToken);
    } catch (e) {
      if (e instanceof OAuthRejected) {
        log("warn", "飞书授权已失效", { person: personId, code: e.code });
        await tx`update feishu_grants set revoked_at = now() where person_id = ${personId}`;
        return null;
      }
      // Feishu could not be reached: a token that still works will do for now.
      if (reason.kind !== "rejected" && g.accessExpiresAt.getTime() > now + 30_000) return { accessToken: current, openId: g.openId };
      throw e;
    }
    const access = seal(key, tokens.accessToken, aad(personId, "access"));
    const nextRefresh = tokens.refreshToken ? seal(key, tokens.refreshToken, aad(personId, "refresh")) : null;
    await tx`
      update feishu_grants set
        access_token = ${access}, access_expires_at = ${tokens.accessExpiresAt},
        refresh_token = coalesce(${nextRefresh}, refresh_token),
        refresh_expires_at = case when ${nextRefresh}::bytea is null then refresh_expires_at else ${tokens.refreshExpiresAt} end,
        scopes = coalesce(${tokens.scopes}, scopes), updated_at = now()
      where person_id = ${personId}`;
    return { accessToken: tokens.accessToken, openId: g.openId };
  });
  if (!outcome) throw new SignedOut();
  return outcome;
}

/** A user access token good for at least five more minutes. */
export async function userToken(deps: GrantDeps, personId: string): Promise<UserToken> {
  const [g] = await select(deps.sql, personId);
  if (!g || g.revokedAt) throw new SignedOut();
  if (g.accessExpiresAt.getTime() > Date.now() + 5 * MINUTE) {
    return { accessToken: unseal(needKey(deps), g.accessToken, aad(personId, "access")), openId: g.openId };
  }
  return refresh(deps, personId, { kind: "expiring" });
}

/**
 * Runs `op` as the person. If Feishu turns down a token that had not expired yet (revoked, or
 * the app's secret was reset), it is refreshed and `op` runs once more: the request was
 * rejected before doing anything.
 */
export async function asUser<T>(deps: GrantDeps, personId: string, op: (token: UserToken) => Promise<T>): Promise<T> {
  const token = await userToken(deps, personId);
  try {
    return await op(token);
  } catch (e) {
    if (!(e instanceof FeishuError && [99991663, 99991668, 99991677].includes(e.code))) throw e;
    return op(await refresh(deps, personId, { kind: "rejected", token: token.accessToken }));
  }
}

/** Refreshes every grant not refreshed for 20 hours, so refresh tokens never lapse. Disabled companies are left alone. */
export async function keepGrantsAlive(deps: GrantDeps): Promise<{ refreshed: number; signedOut: number; failed: number }> {
  const due = await deps.sql<{ personId: string }[]>`
    select g.person_id from feishu_grants g join people p on p.id = g.person_id join tenants t on t.id = p.tenant_id
    where g.revoked_at is null and g.updated_at < now() - interval '20 hours' and t.disabled_at is null`;
  const result = { refreshed: 0, signedOut: 0, failed: 0 };
  for (const { personId } of due) {
    try {
      await refresh(deps, personId, { kind: "keepalive" });
      result.refreshed += 1;
    } catch (e) {
      if (e instanceof SignedOut) result.signedOut += 1;
      else {
        result.failed += 1;
        log("warn", "刷新飞书授权失败，稍后再试", { person: personId, err: e });
      }
    }
  }
  return result;
}

export async function grantScopes(sql: Sql, personId: string): Promise<{ scopes: string; revoked: boolean } | null> {
  const [g] = await sql<{ scopes: string; revokedAt: Date | null }[]>`select scopes, revoked_at from feishu_grants where person_id = ${personId}`;
  return g ? { scopes: g.scopes, revoked: !!g.revokedAt } : null;
}
