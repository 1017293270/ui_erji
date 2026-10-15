import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Companies, newJoinCode, normalizeJoinCode } from "./companies";
import { seal, unseal } from "./crypto";
import type { Sql } from "./db";
import { keepGrantsAlive } from "./grants";
import { createApp } from "./http";
import { type Answer, type FakeRequest, fakeFeishu, fakeFetch, ok } from "./testing/feishu";
import { freshDb, hasDb } from "./testing/db";
import { answerCard } from "./voiceprints";

const KEY = randomBytes(32);

/** Response bodies, loosely typed for assertions. */
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("join codes", () => {
  it("are six characters nobody misreads, typed in any case", () => {
    for (let i = 0; i < 50; i++) expect(newJoinCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(normalizeJoinCode(" k7m2-qx ")).toBe("K7M2QX");
  });
});

describe("crypto", () => {
  it("opens only what it sealed, for the same purpose", () => {
    const sealed = seal(KEY, "u-secret", "p1:access");
    expect(sealed.includes(Buffer.from("u-secret"))).toBe(false);
    expect(unseal(KEY, sealed, "p1:access")).toBe("u-secret");
    expect(() => unseal(KEY, sealed, "p2:access")).toThrow();
    expect(() => unseal(randomBytes(32), sealed, "p1:access")).toThrow();
  });
});

/** Feishu as the tests need it: two companies' apps, sign-in, a small directory, a calendar, refreshable tokens. */
function world() {
  const state = {
    apps: {
      cli_test: { secret: "secret", tenantKey: "tk_echomind", name: "回声科技", person: { open_id: "ou_me", name: "张三" } },
      cli_b: { secret: "secret-b", tenantKey: "tk_b", name: "乙公司", person: { open_id: "ou_wang", name: "王五" } },
    } as Record<string, { secret: string; tenantKey: string; name: string; person: { open_id: string; name: string } }>,
    /** The tenant user_info reports instead, for an account from elsewhere. */
    userTenant: null as string | null,
    issued: 0,
    refreshes: 0,
    refreshRejected: false,
    refreshDelayMs: 0,
    directoryDown: false,
    rejectAccess: new Set<string>(),
    /** Cards the bot sent, and the ones it changed afterwards. */
    cards: [] as { to: string; card: Record<string, any> }[],
    cardUpdates: [] as { id: string; card: Record<string, any> }[],
    /** People outside the app's availability scope. */
    unreachable: new Set<string>(),
    /** Runs after a card arrives, before Feishu answers the bot: a press that quick. */
    whileSending: null as null | (() => Promise<unknown>),
  };
  /** The app each user token came from, and the refresh tokens not spent yet. */
  const issuedBy = new Map<string, string>();
  const liveRefresh = new Set<string>();
  const tokens = (appId: string) => {
    const n = ++state.issued;
    issuedBy.set(`u-${n}`, appId);
    liveRefresh.add(`r-${n}`);
    return {
      code: 0,
      access_token: `u-${n}`,
      expires_in: 7200,
      refresh_token: `r-${n}`,
      refresh_token_expires_in: 604_800,
      scope: "offline_access task:task:write calendar:calendar:read calendar:calendar.event:read",
    };
  };
  const bearer = (req: FakeRequest) => req.authorization?.replace(/^Bearer /, "") ?? "";
  const handler = async (req: FakeRequest): Promise<Answer> => {
    const body = req.body as Record<string, string>;
    switch (req.path) {
      case "/open-apis/authen/v2/oauth/token": {
        const app = state.apps[body.client_id!];
        if (!app || body.client_secret !== app.secret) return [400, { code: 20002, error: "invalid_client", error_description: "app_id and app_secret did not match" }];
        if (body.grant_type === "authorization_code") {
          if (body.code !== "good-code") return [400, { code: 20003, error: "invalid_grant", error_description: "code used" }];
          return [200, tokens(body.client_id!)];
        }
        state.refreshes += 1;
        if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
        if (state.refreshRejected || !liveRefresh.delete(body.refresh_token!)) return [400, { code: 20064, error: "invalid_grant" }];
        return [200, tokens(body.client_id!)];
      }
      case "/open-apis/authen/v1/user_info": {
        const app = state.apps[issuedBy.get(bearer(req)) ?? "cli_test"]!;
        return ok({ ...app.person, en_name: "", union_id: "on_me", enterprise_email: "zs@example.com", tenant_key: state.userTenant ?? app.tenantKey, avatar_url: "https://a.test/me.png" });
      }
      case "/open-apis/auth/v3/tenant_access_token/internal": {
        const app = state.apps[body.app_id!];
        if (!app || body.app_secret !== app.secret) return [400, { code: 10015, msg: "wrong app secret" }];
        return [200, { code: 0, tenant_access_token: `t-${body.app_id}`, expire: 7200 }];
      }
      case "/open-apis/tenant/v2/tenant/query": {
        const app = state.apps[bearer(req).replace(/^t-/, "")];
        if (!app) return [401, { code: 99991663, msg: "invalid access token" }];
        return ok({ tenant: { name: app.name, tenant_key: app.tenantKey, display_id: "F000", tenant_tag: 0 } });
      }
      case "/open-apis/contact/v3/departments/0/children":
        if (state.directoryDown) throw new TypeError("fetch failed");
        return ok({ items: [{ open_department_id: "od-1", name: "产品部" }] });
      case "/open-apis/contact/v3/users/find_by_department":
        return ok({ items: req.query.get("department_id") === "od-1" ? [{ open_id: "ou_me", name: "张三", status: {} }, { open_id: "ou_li", name: "李雷", status: {} }] : [] });
      case "/open-apis/calendar/v4/calendars/primary":
        if (state.rejectAccess.has(req.authorization ?? "")) return [401, { code: 99991668, msg: "invalid access token" }];
        return ok({ calendars: [{ calendar: { calendar_id: "cal" } }] });
      case "/open-apis/calendar/v4/calendars/cal/events/instance_view":
        return ok({ items: [] });
      case "/open-apis/task/v2/tasks":
        return ok({ task: { guid: "task-1", url: "https://applink.feishu.cn/client/todo/detail?guid=task-1" } });
      case "/open-apis/im/v1/messages": {
        const message = req.body as { receive_id: string; content: string };
        if (state.unreachable.has(message.receive_id)) return [400, { code: 230013, msg: "Bot has NO availability to this user." }];
        state.cards.push({ to: message.receive_id, card: JSON.parse(message.content) });
        await state.whileSending?.();
        return ok({ message_id: `om_${state.cards.length}` });
      }
    }
    if (req.method === "PATCH" && req.path.startsWith("/open-apis/im/v1/messages/")) {
      state.cardUpdates.push({ id: req.path.split("/").pop()!, card: JSON.parse((req.body as { content: string }).content) });
      return ok({});
    }
    return [404, { code: 404, msg: req.path }];
  };
  return { state, ...fakeFeishu(handler) };
}

describe.skipIf(!hasDb)("api", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let sql: Sql;
  beforeAll(async () => {
    db = await freshDb();
    sql = db.sql;
  });
  afterAll(() => db?.drop());

  let w: ReturnType<typeof world>;
  let llm: ReturnType<typeof fakeFetch>;
  let companies: Companies;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    await sql`truncate sessions, feishu_grants, people, tenants cascade`;
    w = world();
    llm = fakeFetch((req) => [200, { id: "chat-1", model: (req.body as { model: string }).model, usage: { prompt_tokens: 12, completion_tokens: 3 } }]);
    companies = new Companies({ sql, key: KEY, defaultApp: { appId: "cli_test", appSecret: "secret" }, admins: ["ou_me"], makeFeishu: w.client });
    await companies.adoptDefault();
    app = createApp({ sql, version: "test", companies, dataKey: KEY, llm: { apiKey: "sk-test", baseUrl: "https://llm.test", model: "deepseek-flash", fetch: llm.fetch } });
  });

  const call = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  };
  const signIn = async (code = "good-code", company?: string) => {
    const res = await call("/v1/auth/feishu", {
      method: "POST",
      json: { code, codeVerifier: "v".repeat(64), redirectUri: "http://127.0.0.1:43517/feishu/callback", device: "测试 Mac", company },
    });
    return { res, body: await json(res) };
  };
  /** The admin (张三, in the default company) adds 乙公司 and gets its join code. */
  const addCompanyB = async () => {
    const admin = (await signIn()).body.token as string;
    const res = await call("/v1/admin/companies", { method: "POST", token: admin, json: { appId: "cli_b", appSecret: "secret-b" } });
    expect(res.status).toBe(200);
    const company = await json(res);
    return { admin, company, joinCode: company.joinCode as string };
  };

  it("tells the desktop how to open the consent page", async () => {
    const res = await call("/v1/auth/feishu/config");
    expect(await res.json()).toEqual({
      appId: "cli_test",
      scopes: ["offline_access", "task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"],
      company: { name: null, joinCode: expect.stringMatching(/^[A-Z2-9]{6}$/) },
    });
  });

  it("signs in: exchanges the code, records the tenant and person, seals the tokens, opens a session", async () => {
    const { res, body } = await signIn();
    expect(res.status).toBe(200);
    expect(body.token).toMatch(/^ems_/);
    expect(body.profile).toEqual({
      name: "张三",
      enName: null,
      openId: "ou_me",
      unionId: "on_me",
      email: "zs@example.com",
      tenantKey: "tk_echomind",
      avatarUrl: "https://a.test/me.png",
    });
    expect(body.missingScopes).toEqual([]);
    const exchange = w.requests.find((r) => r.path.endsWith("/oauth/token"))!;
    expect(exchange.body).toMatchObject({ grant_type: "authorization_code", code: "good-code", code_verifier: "v".repeat(64), client_id: "cli_test" });

    const [grant] = await sql<{ accessToken: Uint8Array; refreshToken: Uint8Array }[]>`select access_token, refresh_token from feishu_grants`;
    expect(Buffer.from(grant!.accessToken).includes(Buffer.from("u-1"))).toBe(false);
    const [session] = await sql<{ tokenHash: Uint8Array; device: string }[]>`select token_hash, device from sessions`;
    expect(Buffer.from(session!.tokenHash).toString("utf8")).not.toContain("ems_");
    expect(session!.device).toBe("测试 Mac");

    const me = await call("/v1/me", { token: body.token });
    expect(await me.json()).toEqual({
      openId: "ou_me",
      name: "张三",
      feishuSignedIn: true,
      missingScopes: [],
      company: { name: null, joinCode: body.company.joinCode },
      admin: true,
    });
    expect((await call("/v1/auth/logout", { method: "POST", token: body.token })).status).toBe(200);
    expect((await call("/v1/me", { token: body.token })).status).toBe(401);
  });

  it("turns away spent codes, other companies, missing and bad sessions", async () => {
    const spent = await signIn("old-code");
    expect(spent.res.status).toBe(400);
    expect(spent.body.error).toEqual({ code: "feishu_rejected", message: "授权码已过期或用过了，请重新登录。" });

    await signIn();
    w.state.userTenant = "tk_other";
    const other = await signIn();
    expect(other.res.status).toBe(403);
    expect(other.body.error.code).toBe("wrong_tenant");

    expect((await call("/v1/directory")).status).toBe(401);
    const bad = await call("/v1/directory", { token: "ems_nope" });
    expect(await bad.json()).toEqual({ error: { code: "unauthorized", message: "登录已过期，请重新用飞书登录。" } });
    const malformed = await call("/v1/auth/feishu", { method: "POST", json: { code: "x" } });
    expect(malformed.status).toBe(400);
  });

  it("serves the directory from the last walk, and falls back to it when Feishu is unreachable", async () => {
    const { body } = await signIn();
    const first = await call("/v1/directory", { token: body.token });
    expect(await first.json()).toEqual([
      { id: "ou_me", name: "张三", feishuOpenId: "ou_me", department: "产品部", aliases: [], external: false },
      { id: "ou_li", name: "李雷", feishuOpenId: "ou_li", department: "产品部", aliases: [], external: false },
    ]);
    const walks = () => w.requests.filter((r) => r.path.endsWith("/departments/0/children")).length;
    await call("/v1/directory", { token: body.token });
    expect(walks()).toBe(1);

    w.state.directoryDown = true;
    const refreshed = await call("/v1/directory?refresh=1", { token: body.token });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toHaveLength(2);
    expect(walks()).toBe(2);
  });

  it("refreshes an expiring user token once, however many requests need it", async () => {
    const { body } = await signIn();
    await sql`update feishu_grants set access_expires_at = now()`;
    w.state.refreshDelayMs = 50;
    const replies = await Promise.all(
      Array.from({ length: 4 }, () => call("/v1/calendar/attendees?start=2026-10-13T09:00:00%2B08:00&end=2026-10-13T10:00:00%2B08:00", { token: body.token })),
    );
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(w.state.refreshes).toBe(1);
    const calendar = w.requests.filter((r) => r.path.endsWith("/calendars/primary"));
    expect(calendar.every((r) => r.authorization === "Bearer u-2")).toBe(true);
  });

  it("retries once with a fresh token when Feishu turns down one that had not expired", async () => {
    const { body } = await signIn();
    w.state.rejectAccess.add("Bearer u-1");
    const res = await call("/v1/calendar/attendees?start=2026-10-13T09:00:00Z&end=2026-10-13T10:00:00Z", { token: body.token });
    expect(res.status).toBe(200);
    expect(w.state.refreshes).toBe(1);
  });

  it("asks for a new sign-in when Feishu refuses the refresh token", async () => {
    const { body } = await signIn();
    await sql`update feishu_grants set access_expires_at = now()`;
    w.state.refreshRejected = true;
    const res = await call("/v1/calendar/attendees?start=2026-10-13T09:00:00Z&end=2026-10-13T10:00:00Z", { token: body.token });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("feishu_signed_out");
    expect(await (await call("/v1/me", { token: body.token })).json()).toMatchObject({ feishuSignedIn: false });
  });

  it("creates a Feishu task as the caller, taking null for a missing due date or description", async () => {
    const { body } = await signIn();
    const create = (json: unknown) => call("/v1/feishu/tasks", { method: "POST", token: body.token, json });
    // Exactly what the desktop sends for a todo without a due date.
    const res = await create({ title: "整理报价单", description: null, due: null, assigneeId: "ou_li" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guid: "task-1", url: "https://applink.feishu.cn/client/todo/detail?guid=task-1" });
    const sent = w.requests.find((r) => r.path === "/open-apis/task/v2/tasks")!;
    expect(sent.authorization).toBe("Bearer u-1");
    expect(sent.body).not.toHaveProperty("due");
    expect(sent.body).not.toHaveProperty("description");
    expect(sent.body).toMatchObject({ summary: "整理报价单", members: [{ id: "ou_li", type: "user", role: "assignee" }] });

    const outside = await create({ title: "跟进", description: null, due: "2026-10-20", assigneeId: "ext-1" });
    expect(outside.status).toBe(400);
    expect((await json(outside)).error.message).toContain("通讯录");
  });

  it("keeps grants alive in the background", async () => {
    await signIn();
    const deps = { sql, companies, key: KEY };
    expect(await keepGrantsAlive(deps)).toEqual({ refreshed: 0, signedOut: 0, failed: 0 });
    await sql`update feishu_grants set updated_at = now() - interval '21 hours'`;
    expect(await keepGrantsAlive(deps)).toEqual({ refreshed: 1, signedOut: 0, failed: 0 });
    w.state.refreshRejected = true;
    await sql`update feishu_grants set updated_at = now() - interval '21 hours'`;
    expect(await keepGrantsAlive(deps)).toEqual({ refreshed: 0, signedOut: 1, failed: 0 });
  });

  it("proxies DeepSeek with the server's key and model, and limits size and rate", async () => {
    const { body } = await signIn();
    const chat = (json: unknown) => call("/v1/llm/chat", { method: "POST", token: body.token, json });
    const res = await chat({ messages: [{ role: "user", content: "你好" }], max_tokens: 5 });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-EchoMind-Upstream")).toBe("deepseek");
    expect(await res.json()).toMatchObject({ model: "deepseek-flash" });
    expect(llm.requests[0]).toMatchObject({ method: "POST", path: "/chat/completions", authorization: "Bearer sk-test" });
    expect(llm.requests[0]!.body).toEqual({ messages: [{ role: "user", content: "你好" }], max_tokens: 5, model: "deepseek-flash" });

    await chat({ model: "deepseek-reasoner", messages: [] });
    expect((llm.requests[1]!.body as { model: string }).model).toBe("deepseek-flash");
    expect((await chat([1])).status).toBe(400);
    expect((await chat({ messages: [{ role: "user", content: "长".repeat(1_100_000) }] })).status).toBe(413);
    expect(await (await call("/v1/llm/status", { token: body.token })).json()).toEqual({ configured: true, model: "deepseek-flash" });

    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await chat({ messages: [] })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const limited = await chat({ messages: [] });
    expect(limited.headers.get("X-EchoMind-Upstream")).toBeNull();
  });

  it("says when DeepSeek cannot be reached, without pretending it answered", async () => {
    const { body } = await signIn();
    const down = createApp({
      sql,
      version: "test",
      companies,
      dataKey: KEY,
      llm: { apiKey: "sk", baseUrl: "https://llm.test", model: "deepseek-flash", fetch: fakeFetch(() => { throw new TypeError("fetch failed"); }).fetch },
    });
    const res = await down.request("/v1/llm/chat", { method: "POST", headers: { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(502);
    expect(res.headers.get("X-EchoMind-Upstream")).toBeNull();
    expect((await json(res)).error.code).toBe("llm_unreachable");
  });

  it("adds a company whose people then sign in with its join code, each company through its own app", async () => {
    const admin = (await signIn()).body.token as string;
    const list = await json(await call("/v1/admin/companies", { token: admin }));
    expect(list.companies).toEqual([
      { id: expect.any(String), name: null, appId: "cli_test", joinCode: expect.any(String), people: 1, disabled: false, isDefault: true, createdAt: expect.any(String) },
    ]);
    expect(list.permissions.scopes.tenant).toContain("tenant:tenant:readonly");
    expect(list.permissions.scopes.user).toContain("offline_access");

    const add = (body: unknown) => call("/v1/admin/companies", { method: "POST", token: admin, json: body });
    const wrong = await add({ appId: "cli_b", appSecret: "nope" });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toMatchObject({ code: "app_rejected", message: expect.stringContaining("凭证与基础信息") });
    expect((await add({ appId: "not-an-app", appSecret: "x" })).status).toBe(400);

    const added = await add({ appId: "cli_b", appSecret: "secret-b" });
    expect(added.status).toBe(200);
    const b = await json(added);
    expect(b).toMatchObject({ name: "乙公司", appId: "cli_b", people: 0, disabled: false, isDefault: false });
    const [row] = await sql<{ feishuAppSecret: Uint8Array }[]>`select feishu_app_secret from tenants where feishu_app_id = 'cli_b'`;
    expect(Buffer.from(row!.feishuAppSecret).includes(Buffer.from("secret-b"))).toBe(false);
    expect(await json(await add({ appId: "cli_b", appSecret: "secret-b" }))).toMatchObject({ error: { code: "company_exists" } });

    // Typed by hand: lower case, a dash.
    const typed = `${b.joinCode.slice(0, 3).toLowerCase()}-${b.joinCode.slice(3)}`;
    const config = await json(await call(`/v1/auth/feishu/config?company=${typed}`));
    expect(config).toMatchObject({ appId: "cli_b", company: { name: "乙公司", joinCode: b.joinCode } });
    expect(await json(await call("/v1/auth/feishu/config?company=ZZZZZZ"))).toMatchObject({ error: { code: "unknown_company" } });

    const wang = await signIn("good-code", b.joinCode);
    expect(wang.res.status).toBe(200);
    expect(wang.body.profile).toMatchObject({ name: "王五", tenantKey: "tk_b" });
    expect(wang.body.company).toEqual({ name: "乙公司", joinCode: b.joinCode });
    const exchanges = w.requests.filter((r) => r.path.endsWith("/oauth/token"));
    expect(exchanges.at(-1)!.body).toMatchObject({ client_id: "cli_b", client_secret: "secret-b" });
    expect(await json(await call("/v1/me", { token: wang.body.token }))).toMatchObject({ company: { name: "乙公司" }, admin: false });
    expect((await call("/v1/admin/companies", { token: wang.body.token })).status).toBe(403);

    await call("/v1/directory", { token: wang.body.token });
    const walk = w.requests.filter((r) => r.path.endsWith("/departments/0/children")).at(-1)!;
    expect(walk.authorization).toBe("Bearer t-cli_b");
    const [counted] = (await json(await call("/v1/admin/companies", { token: admin }))).companies.filter((c: { appId: string }) => c.appId === "cli_b");
    expect(counted.people).toBe(1);
  });

  it("disables a company: its people are out at their next request and cannot sign in until it is enabled", async () => {
    const { admin, company, joinCode } = await addCompanyB();
    const wang = (await signIn("good-code", joinCode)).body.token as string;
    const set = (id: string, action: "disable" | "enable") => call(`/v1/admin/companies/${id}/${action}`, { method: "POST", token: admin });

    expect(await json(await set(company.id, "disable"))).toMatchObject({ disabled: true });
    expect((await call("/v1/me", { token: wang })).status).toBe(401);
    expect(await json(await call(`/v1/auth/feishu/config?company=${joinCode}`))).toMatchObject({ error: { code: "company_disabled" } });
    expect((await signIn("good-code", joinCode)).body.error.code).toBe("company_disabled");

    const own = (await json(await call("/v1/admin/companies", { token: admin }))).companies.find((c: { isDefault: boolean }) => c.isDefault);
    expect(await json(await set(own.id, "disable"))).toMatchObject({ error: { code: "own_company" } });
    expect((await call("/v1/admin/companies/not-a-uuid/disable", { method: "POST", token: admin })).status).toBe(404);

    await set(company.id, "enable");
    expect((await signIn("good-code", joinCode)).res.status).toBe(200);
  });

  it("keeps people signed in when an App Secret goes wrong, until the admin puts in the new one", async () => {
    const { admin, company, joinCode } = await addCompanyB();
    const wang = (await signIn("good-code", joinCode)).body.token as string;
    const attendees = () => call("/v1/calendar/attendees?start=2026-10-13T09:00:00Z&end=2026-10-13T10:00:00Z", { token: wang });

    // The secret is reset in the Feishu console; the next refresh is turned down.
    w.state.apps.cli_b!.secret = "secret-b2";
    await sql`update feishu_grants set access_expires_at = now() where person_id = (select id from people where open_id = 'ou_wang')`;
    const failing = await attendees();
    expect(failing.status).toBe(502);
    expect((await json(failing)).error.message).toContain("公司管理");
    const [grant] = await sql<{ revokedAt: Date | null }[]>`select revoked_at from feishu_grants g join people p on p.id = g.person_id where p.open_id = 'ou_wang'`;
    expect(grant!.revokedAt).toBeNull();

    const replace = (appSecret: string) => call(`/v1/admin/companies/${company.id}/secret`, { method: "POST", token: admin, json: { appSecret } });
    expect(await json(await replace("secret-b"))).toMatchObject({ error: { code: "app_rejected" } });
    expect(await json(await replace("secret-b2"))).toMatchObject({ name: "乙公司" });
    expect((await attendees()).status).toBe(200);
    expect(await json(await call(`/v1/admin/companies/${company.id}/check`, { method: "POST", token: admin }))).toMatchObject({ name: "乙公司" });

    // A restart takes the .env app in again without undoing a secret saved since.
    const [own] = await sql<{ id: string }[]>`select id from tenants where feishu_app_id = 'cli_test'`;
    await sql`update tenants set feishu_app_secret = ${seal(KEY, "saved-later", "app-secret:cli_test")} where id = ${own!.id}`;
    await companies.adoptDefault();
    const [kept] = await sql<{ feishuAppSecret: Uint8Array }[]>`select feishu_app_secret from tenants where id = ${own!.id}`;
    expect(unseal(KEY, kept!.feishuAppSecret, "app-secret:cli_test")).toBe("saved-later");
  });

  it("slows down anyone guessing join codes, but not people typing the right one", async () => {
    const [own] = await sql<{ joinCode: string }[]>`select join_code from tenants`;
    for (let i = 0; i < 30; i++) expect((await call(`/v1/auth/feishu/config?company=${own!.joinCode}`)).status).toBe(200);

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call(`/v1/auth/feishu/config?company=GUESS${i}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await signIn("good-code", own!.joinCode)).body.error.code).toBe("rate_limited");
    // Without a code nothing is being guessed.
    expect((await call("/v1/auth/feishu/config")).status).toBe(200);
  });

  it("counts guesses sent all at once", async () => {
    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => call(`/v1/auth/feishu/config?company=GUESS${i}`)));
    const statuses = replies.map((r) => r.status);
    expect(statuses.filter((s) => s === 404)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
  });

  /** A voice: 192 numbers along `axis`, with a little of `other` mixed in. */
  const voice = (axis: number, other = axis + 1, mix = 0.2) => Array.from({ length: 192 }, (_, i) => (i === axis ? 1 : i === other ? mix : 0));
  /** 张三 signed in, with 李雷 in the directory. */
  const voiceprintsAs = async () => {
    const token = (await signIn()).body.token as string;
    await call("/v1/directory", { token });
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where feishu_app_id = 'cli_test'`;
    const vp = (path = "", init: RequestInit & { json?: unknown } = {}) => call(`/v1/voiceprints${path}`, { token, ...init });
    return { vp, tenantId: tenant!.id, deps: { sql, companies, key: KEY } };
  };

  it("keeps a colleague's voiceprint only once they agree on the card, then recognises them", async () => {
    const { vp, tenantId, deps } = await voiceprintsAs();

    const early = await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 20 } });
    expect(await json(early)).toMatchObject({ error: { code: "consent_needed" } });

    const asked = await vp("/ou_li/ask", { method: "POST", json: { meeting: "周会" } });
    expect(await json(asked)).toMatchObject({ openId: "ou_li", status: "asked", enrolled: false, askedBy: "张三" });
    expect(w.state.cards.map((c) => c.to)).toEqual(["ou_li"]);
    expect(JSON.stringify(w.state.cards[0]!.card)).toContain("会议「周会」");
    expect(await json(await vp("/ou_li/ask", { method: "POST", json: {} }))).toMatchObject({ error: { code: "asked_recently" } });

    // Only the person the card is about can answer it.
    const agree = w.state.cards[0]!.card.elements.at(-1).actions[0].value;
    expect(agree).toEqual({ voiceprint: "agree", person: "ou_li" });
    expect((await answerCard(deps, tenantId, { operatorOpenId: "ou_me", value: agree })).toast.type).toBe("error");
    const agreed = await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: agree });
    expect(agreed.card?.data).toMatchObject({ header: { template: "green" } });

    const saved = await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 20 } });
    expect(await json(saved)).toMatchObject({ status: "agreed", enrolled: true, samples: 1, seconds: 20 });
    const [row] = await sql<{ vector: Uint8Array }[]>`select vector from voiceprints v join people p on p.id = v.person_id where p.open_id = 'ou_li'`;
    expect(Buffer.from(row!.vector).includes(Buffer.from(Float32Array.of(1 / Math.hypot(1, 0.2)).buffer))).toBe(false);
    const elsewhere = await vp("/ou_li/samples", { method: "POST", json: { vector: voice(50), seconds: 20 } });
    expect(await json(elsewhere)).toMatchObject({ error: { code: "not_same_person" } });
    const short = await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 2 } });
    expect(await json(short)).toMatchObject({ error: { code: "too_short" } });

    // Naming yourself is your own consent.
    expect(await json(await vp("/ou_me/samples", { method: "POST", json: { vector: voice(100), seconds: 30 } }))).toMatchObject({ status: "agreed", enrolled: true });
    expect(await json(await vp("/ou_me/ask", { method: "POST", json: {} }))).toMatchObject({ error: { code: "self" } });

    // S2 and S5 both sound like 李雷: the closer one is him. S3 is nobody known; S4 says too little.
    const match = await vp("/match", {
      method: "POST",
      json: {
        voices: [
          { speakerId: "S2", vector: voice(1, 2, 0.3), seconds: 40 },
          { speakerId: "S3", vector: voice(150), seconds: 40 },
          { speakerId: "S4", vector: voice(100), seconds: 1 },
          { speakerId: "S5", vector: voice(1, 3, 0.25), seconds: 40 },
        ],
      },
    });
    expect(await json(match)).toEqual({ matches: [{ speakerId: "S2", openId: "ou_li", score: 1 }] });

    const list = (await json(await vp())).voiceprints as { openId: string; status: string; enrolled: boolean }[];
    expect(list.map((v) => [v.openId, v.status, v.enrolled])).toEqual([["ou_me", "agreed", true], ["ou_li", "agreed", true]]);

    // 李雷 deletes his on the card; 张三 deletes his own in the app.
    const deleted = await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "delete", person: "ou_li" } });
    expect(deleted.toast.content).toBe("已删除你的声纹。");
    expect((await vp("/ou_me", { method: "DELETE" })).status).toBe(200);
    expect((await json(await vp())).voiceprints).toEqual([]);
  });

  it("declining drops what was kept, and a deletion in the app shows on the card", async () => {
    const { vp, tenantId, deps } = await voiceprintsAs();
    await vp("/ou_li/ask", { method: "POST", json: {} });
    await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "agree", person: "ou_li" } });
    await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 20 } });

    // The 不同意 button of the first card, pressed later.
    await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "decline", person: "ou_li" } });
    expect((await json(await vp())).voiceprints).toMatchObject([{ openId: "ou_li", status: "declined", enrolled: false, samples: 0 }]);
    expect(await json(await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 20 } }))).toMatchObject({ error: { code: "consent_needed" } });

    await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "agree", person: "ou_li" } });
    await vp("/ou_li", { method: "DELETE" });
    expect(w.state.cardUpdates).toHaveLength(1);
    expect(w.state.cardUpdates[0]!.id).toBe("om_1");
    expect(JSON.stringify(w.state.cardUpdates[0]!.card)).toContain("你的声纹已删除");
  });

  it("keeps an answer given while the card was still being sent", async () => {
    const { vp, tenantId, deps } = await voiceprintsAs();
    w.state.whileSending = () => answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "decline", person: "ou_li" } });
    expect(await json(await vp("/ou_li/ask", { method: "POST", json: {} }))).toMatchObject({ status: "declined", askedBy: "张三" });
    expect(await json(await vp("/ou_li/samples", { method: "POST", json: { vector: voice(1), seconds: 20 } }))).toMatchObject({ error: { code: "consent_needed" } });
  });

  it("writes nothing when the answer to a card would come too late", async () => {
    const { vp, tenantId, deps } = await voiceprintsAs();
    await vp("/ou_li/ask", { method: "POST", json: {} });
    const late = await answerCard(deps, tenantId, { operatorOpenId: "ou_li", value: { voiceprint: "agree", person: "ou_li" } }, Date.now() - 1).catch((e: Error) => e);
    expect(late).toBeInstanceOf(Error);
    expect((await json(await vp())).voiceprints).toMatchObject([{ openId: "ou_li", status: "asked" }]);
  });

  it("merges first samples sent at the same moment", async () => {
    const { vp, tenantId } = await voiceprintsAs();
    // An insert not committed yet holds both samples at the same point, as a slow database would.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const blocker = sql
      .begin(async (tx) => {
        await tx`insert into voiceprints (person_id, status) select id, 'agreed' from people where tenant_id = ${tenantId} and open_id = 'ou_me'`;
        holding();
        await released;
        throw new Error("rolled back");
      })
      .catch(() => {});
    await held;
    const sent = [0, 0.4].map((mix) => vp("/ou_me/samples", { method: "POST", json: { vector: voice(100, 101, mix), seconds: 30 } }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await blocker;
    await Promise.all(sent);
    expect((await json(await vp())).voiceprints).toMatchObject([{ openId: "ou_me", samples: 2, seconds: 60 }]);
    // Both went in: the voiceprint sits between them, not on either one.
    const match = await vp("/match", { method: "POST", json: { voices: [{ speakerId: "S1", vector: voice(100, 101, 0.2), seconds: 40 }] } });
    expect(await json(match)).toEqual({ matches: [{ speakerId: "S1", openId: "ou_me", score: 1 }] });
  });

  it("says why a card could not be sent, and keeps companies apart", async () => {
    const { vp } = await voiceprintsAs();
    w.state.unreachable.add("ou_li");
    const unreachable = await vp("/ou_li/ask", { method: "POST", json: {} });
    expect(unreachable.status).toBe(502);
    expect((await json(unreachable)).error.message).toContain("可用范围");
    expect((await vp("/ou_nobody/ask", { method: "POST", json: {} })).status).toBe(404);
    expect((await vp("/not-an-id/ask", { method: "POST", json: {} })).status).toBe(404);
    expect(await sql`select 1 from voiceprints`).toHaveLength(0);

    await vp("/ou_me/samples", { method: "POST", json: { vector: voice(100), seconds: 30 } });
    const { joinCode } = await addCompanyB();
    const wang = (await signIn("good-code", joinCode)).body.token as string;
    const asWang = (path: string, init: RequestInit & { json?: unknown } = {}) => call(`/v1/voiceprints${path}`, { token: wang, ...init });
    expect((await json(await asWang(""))).voiceprints).toEqual([]);
    expect((await asWang("/ou_me", { method: "DELETE" })).status).toBe(404);
    expect(await json(await asWang("/match", { method: "POST", json: { voices: [{ speakerId: "S2", vector: voice(100), seconds: 40 }] } }))).toEqual({ matches: [] });
  });
});
