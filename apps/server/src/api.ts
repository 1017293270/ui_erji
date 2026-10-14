import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Sql } from "./db";
import { meetingAttendees, meetingWindow } from "./feishu/calendar";
import { explain, type Feishu, type Identity, NetworkError } from "./feishu/client";
import { exchangeCode, fetchProfile, missingScopes, OAuthRejected, SCOPES } from "./feishu/oauth";
import { createTask, taskBody } from "./feishu/tasks";
import { asUser, grantScopes, SignedOut, storeGrant } from "./grants";
import { type LlmDeps, LlmUnreachable, proxyChat, RateLimit } from "./llm";
import { log } from "./log";
import { directory, tenantFor, upsertSignedIn, WrongTenant } from "./people";
import { createSession, findSession, type Me, revokeSession } from "./sessions";

export type ApiDeps = { sql: Sql; feishu: Feishu; dataKey: Buffer | null; llm: LlmDeps };

type Env = { Variables: { me: Me } };

const fail = (code: string, message: string) => ({ error: { code, message } });

/** A Feishu call that went wrong, as the response the desktop app shows. */
function feishuFailure(c: Context, e: unknown, identity: Identity) {
  if (e instanceof SignedOut) return c.json(fail("feishu_signed_out", e.message), 401);
  if (e instanceof RangeError) return c.json(fail("bad_request", e.message), 400);
  if (e instanceof NetworkError) return c.json(fail("feishu_offline", explain(e, identity)), 503);
  log("warn", "飞书接口出错", { path: c.req.path, err: e instanceof Error ? e.message : String(e) });
  return c.json(fail("feishu", explain(e, identity)), 502);
}

async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(fail("bad_request", "请求不是合法的 JSON。"), 400);
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : c.json(fail("bad_request", `请求格式不对：${parsed.error.issues[0]?.message ?? ""}`), 400);
}

const SignIn = z.strictObject({
  code: z.string().min(1).max(512),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.url().max(256),
  device: z.string().max(120).optional(),
});

// The desktop sends a missing description or due date as null (a Rust Option), so null means "none".
const NewTask = z.strictObject({
  title: z.string().max(10_000),
  description: z.string().max(20_000).nullish(),
  due: z.string().max(20).nullish(),
  assigneeId: z.string().max(100),
});

/** Everything under /v1. All of it needs a session except finding out how to sign in. */
export function api(deps: ApiDeps): Hono<Env> {
  const app = new Hono<Env>();
  const grants = { sql: deps.sql, feishu: deps.feishu, key: deps.dataKey };
  const llmLimit = new RateLimit(30, 60_000);

  const auth = createMiddleware<Env>(async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const me = token ? await findSession(deps.sql, token) : null;
    if (!me) return c.json(fail("unauthorized", "登录已过期，请重新用飞书登录。"), 401);
    c.set("me", me);
    await next();
  });

  // ---------------------------------------------------------------------------
  // Sign-in

  /** What the desktop needs to open Feishu's consent page: no secrets. */
  app.get("/auth/feishu/config", (c) => {
    if (!deps.feishu.app) return c.json(fail("feishu_not_configured", "服务器还没有配置飞书应用，请联系管理员。"), 503);
    return c.json({ appId: deps.feishu.app.appId, scopes: SCOPES });
  });

  /** The desktop got a code on its loopback redirect; the server turns it into an EchoMind session. */
  app.post("/auth/feishu", async (c) => {
    const input = await readJson(c, SignIn);
    if (input instanceof Response) return input;
    if (!deps.feishu.app) return c.json(fail("feishu_not_configured", "服务器还没有配置飞书应用，请联系管理员。"), 503);
    try {
      const tokens = await exchangeCode(deps.feishu, input);
      const profile = await fetchProfile(deps.feishu, tokens.accessToken);
      const tenantId = await tenantFor(deps.sql, deps.feishu.app.appId, profile.tenantKey);
      const personId = await upsertSignedIn(deps.sql, tenantId, profile);
      await storeGrant(grants, personId, tokens);
      const session = await createSession(deps.sql, personId, input.device ?? null);
      log("info", "登录", { person: personId, device: input.device ?? null });
      return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString(), profile, missingScopes: missingScopes(tokens.scopes) });
    } catch (e) {
      if (e instanceof OAuthRejected) return c.json(fail("feishu_rejected", e.message), 400);
      if (e instanceof WrongTenant) return c.json(fail("wrong_tenant", e.message), 403);
      return feishuFailure(c, e, "user");
    }
  });

  app.post("/auth/logout", auth, async (c) => {
    await revokeSession(deps.sql, c.get("me").sessionId);
    return c.json({ ok: true });
  });

  app.get("/me", auth, async (c) => {
    const me = c.get("me");
    const grant = await grantScopes(deps.sql, me.personId);
    return c.json({
      openId: me.openId,
      name: me.name,
      feishuSignedIn: !!grant && !grant.revoked,
      missingScopes: grant && !grant.revoked ? missingScopes(grant.scopes) : SCOPES,
    });
  });

  // ---------------------------------------------------------------------------
  // Feishu, on the person's behalf

  app.get("/directory", auth, async (c) => {
    try {
      return c.json(await directory(deps.sql, deps.feishu, c.get("me").tenantId, c.req.query("refresh") === "1"));
    } catch (e) {
      return feishuFailure(c, e, "app");
    }
  });

  app.get("/calendar/attendees", auth, async (c) => {
    try {
      const window = meetingWindow(c.req.query("start") ?? "", c.req.query("end") ?? "");
      return c.json(await asUser(grants, c.get("me").personId, (token) => meetingAttendees(deps.feishu, token, window)));
    } catch (e) {
      return feishuFailure(c, e, "user");
    }
  });

  /** Creates a Feishu task as the caller. Step 3 replaces it with publishing a meeting. */
  app.post("/feishu/tasks", auth, async (c) => {
    const input = await readJson(c, NewTask);
    if (input instanceof Response) return input;
    try {
      const body = taskBody(input);
      return c.json(await asUser(grants, c.get("me").personId, (token) => createTask(deps.feishu, token.accessToken, body)));
    } catch (e) {
      return feishuFailure(c, e, "user");
    }
  });

  // ---------------------------------------------------------------------------
  // DeepSeek

  app.get("/llm/status", auth, (c) => c.json({ configured: !!deps.llm.apiKey, model: deps.llm.model }));

  app.post(
    "/llm/chat",
    auth,
    bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json(fail("too_large", "发给 DeepSeek 的内容太长了（超过 2 MB）。"), 413) }),
    async (c) => {
      const me = c.get("me");
      const apiKey = deps.llm.apiKey;
      if (!apiKey) return c.json(fail("llm_not_configured", "服务器还没有配置 DeepSeek，请联系管理员。"), 503);
      if (!llmLimit.take(me.personId)) return c.json(fail("rate_limited", "生成纪要的请求太频繁了，请等一分钟再试。"), 429);
      const body = await readJson(c, z.record(z.string(), z.unknown()));
      if (body instanceof Response) return body;
      // The server decides the model; an older app asking for another one still gets an answer.
      const started = performance.now();
      try {
        const upstream = await proxyChat({ ...deps.llm, apiKey }, { ...body, model: deps.llm.model });
        log("info", "DeepSeek", { person: me.personId, status: upstream.status, ms: Math.round(performance.now() - started), ...upstream.usage });
        return c.body(upstream.body, upstream.status as 200, { "Content-Type": "application/json; charset=utf-8", "X-EchoMind-Upstream": "deepseek" });
      } catch (e) {
        if (!(e instanceof LlmUnreachable)) throw e;
        log("warn", "连不上 DeepSeek", { person: me.personId, ms: Math.round(performance.now() - started), err: e.message });
        return c.json(fail("llm_unreachable", e.message), 502);
      }
    },
  );

  return app;
}
