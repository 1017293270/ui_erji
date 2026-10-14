import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seal, unseal } from "./crypto";
import type { Sql } from "./db";
import { keepGrantsAlive } from "./grants";
import { createApp } from "./http";
import { type Answer, type FakeRequest, fakeFeishu, fakeFetch, ok } from "./testing/feishu";
import { freshDb, hasDb } from "./testing/db";

const KEY = randomBytes(32);

/** Response bodies, loosely typed for assertions. */
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("crypto", () => {
  it("opens only what it sealed, for the same purpose", () => {
    const sealed = seal(KEY, "u-secret", "p1:access");
    expect(sealed.includes(Buffer.from("u-secret"))).toBe(false);
    expect(unseal(KEY, sealed, "p1:access")).toBe("u-secret");
    expect(() => unseal(KEY, sealed, "p2:access")).toThrow();
    expect(() => unseal(randomBytes(32), sealed, "p1:access")).toThrow();
  });
});

/** Feishu as the tests need it: sign-in, a small directory, a calendar, refreshable tokens. */
function world() {
  const state = {
    tenantKey: "tk_echomind",
    issued: 0,
    refreshes: 0,
    refreshRejected: false,
    refreshDelayMs: 0,
    directoryDown: false,
    rejectAccess: new Set<string>(),
  };
  const tokens = (n: number) => ({
    code: 0,
    access_token: `u-${n}`,
    expires_in: 7200,
    refresh_token: `r-${n}`,
    refresh_token_expires_in: 604_800,
    scope: "offline_access task:task:write calendar:calendar:read calendar:calendar.event:read",
  });
  const handler = async (req: FakeRequest): Promise<Answer> => {
    const body = req.body as Record<string, string>;
    switch (req.path) {
      case "/open-apis/authen/v2/oauth/token":
        if (body.client_secret !== "secret") return [400, { code: 20002, error: "invalid_client" }];
        if (body.grant_type === "authorization_code") {
          if (body.code !== "good-code") return [400, { code: 20003, error: "invalid_grant", error_description: "code used" }];
          return [200, tokens(++state.issued)];
        }
        state.refreshes += 1;
        if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
        if (state.refreshRejected || body.refresh_token !== `r-${state.issued}`) return [400, { code: 20064, error: "invalid_grant" }];
        return [200, tokens(++state.issued)];
      case "/open-apis/authen/v1/user_info":
        return ok({ name: "张三", en_name: "", open_id: "ou_me", union_id: "on_me", enterprise_email: "zs@example.com", tenant_key: state.tenantKey, avatar_url: "https://a.test/me.png" });
      case "/open-apis/auth/v3/tenant_access_token/internal":
        return [200, { code: 0, tenant_access_token: "t-app", expire: 7200 }];
      case "/open-apis/contact/v3/departments/0/children":
        if (state.directoryDown) throw new TypeError("fetch failed");
        return ok({ items: [{ open_department_id: "od-1", name: "产品部" }] });
      case "/open-apis/contact/v3/users/find_by_department":
        return ok({ items: req.query.get("department_id") === "od-1" ? [{ open_id: "ou_me", name: "张三", status: {} }, { open_id: "ou_li", name: "李雷", status: {} }] : [] });
      case "/open-apis/calendar/v4/calendars/primary":
        if (req.authorization && state.rejectAccess.has(req.authorization)) return [401, { code: 99991668, msg: "invalid access token" }];
        return ok({ calendars: [{ calendar: { calendar_id: "cal" } }] });
      case "/open-apis/calendar/v4/calendars/cal/events/instance_view":
        return ok({ items: [] });
      case "/open-apis/task/v2/tasks":
        return ok({ task: { guid: "task-1", url: "https://applink.feishu.cn/client/todo/detail?guid=task-1" } });
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
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    await sql`truncate sessions, feishu_grants, people, tenants cascade`;
    w = world();
    llm = fakeFetch((req) => [200, { id: "chat-1", model: (req.body as { model: string }).model, usage: { prompt_tokens: 12, completion_tokens: 3 } }]);
    app = createApp({ sql, version: "test", feishu: w.feishu, dataKey: KEY, llm: { apiKey: "sk-test", baseUrl: "https://llm.test", model: "deepseek-flash", fetch: llm.fetch } });
  });

  const call = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
  };
  const signIn = async (code = "good-code") => {
    const res = await call("/v1/auth/feishu", {
      method: "POST",
      json: { code, codeVerifier: "v".repeat(64), redirectUri: "http://127.0.0.1:43517/feishu/callback", device: "测试 Mac" },
    });
    return { res, body: await json(res) };
  };

  it("tells the desktop how to open the consent page", async () => {
    const res = await call("/v1/auth/feishu/config");
    expect(await res.json()).toEqual({ appId: "cli_test", scopes: ["offline_access", "task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"] });
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
    expect(await me.json()).toEqual({ openId: "ou_me", name: "张三", feishuSignedIn: true, missingScopes: [] });
    expect((await call("/v1/auth/logout", { method: "POST", token: body.token })).status).toBe(200);
    expect((await call("/v1/me", { token: body.token })).status).toBe(401);
  });

  it("turns away spent codes, other companies, missing and bad sessions", async () => {
    const spent = await signIn("old-code");
    expect(spent.res.status).toBe(400);
    expect(spent.body.error).toEqual({ code: "feishu_rejected", message: "授权码已过期或用过了，请重新登录。" });

    await signIn();
    w.state.tenantKey = "tk_other";
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
    const deps = { sql, feishu: w.feishu, key: KEY };
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
      feishu: w.feishu,
      dataKey: KEY,
      llm: { apiKey: "sk", baseUrl: "https://llm.test", model: "deepseek-flash", fetch: fakeFetch(() => { throw new TypeError("fetch failed"); }).fetch },
    });
    const res = await down.request("/v1/llm/chat", { method: "POST", headers: { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(502);
    expect(res.headers.get("X-EchoMind-Upstream")).toBeNull();
    expect((await json(res)).error.code).toBe("llm_unreachable");
  });
});
