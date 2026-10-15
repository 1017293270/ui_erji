import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { APP_PERMISSIONS, type Companies, CompanyError, WrongTenant } from "./companies";
import type { Sql } from "./db";
import { meetingAttendees, meetingWindow } from "./feishu/calendar";
import { explain, type Identity, NetworkError } from "./feishu/client";
import { exchangeCode, fetchProfile, missingScopes, OAuthRejected, SCOPES } from "./feishu/oauth";
import { createTask, taskBody } from "./feishu/tasks";
import { asUser, grantScopes, SignedOut, storeGrant } from "./grants";
import { type LlmDeps, LlmUnreachable, proxyChat, RateLimit } from "./llm";
import { log } from "./log";
import { directory, upsertSignedIn } from "./people";
import { createSession, findSession, type Me, revokeSession } from "./sessions";

export type ApiDeps = { sql: Sql; companies: Companies; dataKey: Buffer | null; llm: LlmDeps };

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

/** A company that cannot be used as asked, as the response the desktop app shows. */
function companyFailure(c: Context, e: unknown) {
  if (e instanceof CompanyError) return c.json(fail(e.code, e.message), e.status);
  throw e;
}

/** Where a request came from; requests made in tests have no socket. */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
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
  /** The company's join code. Builds from before join codes leave it out and get the default company. */
  company: z.string().max(32).optional(),
});

const AppSecret = z.string().trim().min(1, "请填写 App Secret。").max(128, "App Secret 太长了，请检查是否复制多了。");
const NewCompany = z.strictObject({
  appId: z.string().trim().max(64).regex(/^cli_[0-9a-z]+$/i, "App ID 是 cli_ 开头的一串字母和数字，请在飞书开发者后台「凭证与基础信息」里复制。"),
  appSecret: AppSecret,
});
const NewSecret = z.strictObject({ appSecret: AppSecret });

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
  const grants = { sql: deps.sql, companies: deps.companies, key: deps.dataKey };
  const llmLimit = new RateLimit(30, 60_000);
  // Join codes name customers: wrong guesses from one address are slowed to a crawl. Right ones
  // never count, so a whole office signing in at once is not held up.
  const wrongCodes = new RateLimit(20, 60_000);

  /**
   * The company a join code opens, counting the wrong codes. Each lookup holds a place until it
   * turns out right, so guesses sent all at once are counted too.
   */
  const doorFor = async (c: Context, code: string | undefined) => {
    if (!code) return deps.companies.door(undefined);
    const from = clientAddress(c);
    if (!wrongCodes.take(from)) throw new CompanyError("rate_limited", 429, "输错加入码的次数太多了，请等一分钟再试。");
    try {
      const door = await deps.companies.door(code);
      wrongCodes.refund(from);
      return door;
    } catch (e) {
      if (!(e instanceof CompanyError && e.code === "unknown_company")) wrongCodes.refund(from);
      throw e;
    }
  };

  const auth = createMiddleware<Env>(async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const me = token ? await findSession(deps.sql, token) : null;
    if (!me) return c.json(fail("unauthorized", "登录已过期，请重新用飞书登录。"), 401);
    c.set("me", me);
    await next();
  });

  // ---------------------------------------------------------------------------
  // Sign-in

  /** What the desktop needs to open the company's Feishu consent page: no secrets. */
  app.get("/auth/feishu/config", async (c) => {
    try {
      const door = await doorFor(c, c.req.query("company"));
      return c.json({ appId: door.appId, scopes: SCOPES, company: { name: door.name, joinCode: door.joinCode } });
    } catch (e) {
      return companyFailure(c, e);
    }
  });

  /** The desktop got a code on its loopback redirect; the server turns it into an EchoMind session. */
  app.post("/auth/feishu", async (c) => {
    const input = await readJson(c, SignIn);
    if (input instanceof Response) return input;
    try {
      const door = await doorFor(c, input.company);
      const tokens = await exchangeCode(door.feishu, input);
      const profile = await fetchProfile(door.feishu, tokens.accessToken);
      await deps.companies.admit(door, profile.tenantKey);
      const personId = await upsertSignedIn(deps.sql, door.id, profile);
      await storeGrant(grants, personId, tokens);
      const session = await createSession(deps.sql, personId, input.device ?? null);
      log("info", "登录", { tenant: door.id, person: personId, device: input.device ?? null });
      return c.json({
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        profile,
        missingScopes: missingScopes(tokens.scopes),
        company: { name: door.name, joinCode: door.joinCode },
      });
    } catch (e) {
      if (e instanceof CompanyError) return companyFailure(c, e);
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
    const [grant, company, admin] = await Promise.all([grantScopes(deps.sql, me.personId), deps.companies.joinCodeOf(me.tenantId), deps.companies.isAdmin(me)]);
    return c.json({
      openId: me.openId,
      name: me.name,
      feishuSignedIn: !!grant && !grant.revoked,
      missingScopes: grant && !grant.revoked ? missingScopes(grant.scopes) : SCOPES,
      company,
      admin,
    });
  });

  // ---------------------------------------------------------------------------
  // Feishu, on the person's behalf

  app.get("/directory", auth, async (c) => {
    const { tenantId } = c.get("me");
    try {
      return c.json(await directory(deps.sql, await deps.companies.feishu(tenantId), tenantId, c.req.query("refresh") === "1"));
    } catch (e) {
      return feishuFailure(c, e, "app");
    }
  });

  app.get("/calendar/attendees", auth, async (c) => {
    try {
      const window = meetingWindow(c.req.query("start") ?? "", c.req.query("end") ?? "");
      const me = c.get("me");
      const feishu = await deps.companies.feishu(me.tenantId);
      return c.json(await asUser(grants, me.personId, (token) => meetingAttendees(feishu, token, window)));
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
      const me = c.get("me");
      const feishu = await deps.companies.feishu(me.tenantId);
      return c.json(await asUser(grants, me.personId, (token) => createTask(feishu, token.accessToken, body)));
    } catch (e) {
      return feishuFailure(c, e, "user");
    }
  });

  // ---------------------------------------------------------------------------
  // 公司管理: only the people named in ECHOMIND_ADMINS

  const admin = createMiddleware<Env>(async (c, next) => {
    if (!(await deps.companies.isAdmin(c.get("me")))) return c.json(fail("forbidden", "只有 EchoMind 管理员能管理公司。"), 403);
    await next();
  });

  /** The company in the path, or a 404 for anything that is not a company id. */
  const companyId = (c: Context): string => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) throw new CompanyError("not_found", 404, "没有这家公司。");
    return id!;
  };

  app.get("/admin/companies", auth, admin, async (c) => c.json({ companies: await deps.companies.list(), permissions: APP_PERMISSIONS }));

  app.post("/admin/companies", auth, admin, async (c) => {
    const input = await readJson(c, NewCompany);
    if (input instanceof Response) return input;
    try {
      return c.json(await deps.companies.add(input));
    } catch (e) {
      return companyFailure(c, e);
    }
  });

  app.post("/admin/companies/:id/check", auth, admin, async (c) => {
    try {
      return c.json(await deps.companies.check(companyId(c)));
    } catch (e) {
      return companyFailure(c, e);
    }
  });

  app.post("/admin/companies/:id/secret", auth, admin, async (c) => {
    const input = await readJson(c, NewSecret);
    if (input instanceof Response) return input;
    try {
      return c.json(await deps.companies.replaceSecret(companyId(c), input.appSecret));
    } catch (e) {
      return companyFailure(c, e);
    }
  });

  for (const action of ["disable", "enable"] as const) {
    app.post(`/admin/companies/:id/${action}`, auth, admin, async (c) => {
      try {
        return c.json(await deps.companies.setDisabled(companyId(c), action === "disable", c.get("me")));
      } catch (e) {
        return companyFailure(c, e);
      }
    });
  }

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
