/**
 * Calls to the Feishu Open Platform under https://open.feishu.cn/open-apis, with the app's own
 * tenant_access_token or a person's user token. Errors are put into words that say what to fix;
 * they reach the desktop app as is.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const OPEN_API = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 20_000;

/** Feishu could not be reached, or did not finish answering. */
export class NetworkError extends Error {}

/** Not a Feishu reply at all: a proxy page, an outage. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Feishu answered with a non-zero code. `scopes` are the permissions it said were missing. */
export class FeishuError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
    readonly scopes: string[] = [],
  ) {
    super(`Feishu ${code}: ${msg}`);
  }
}

/** A successful reply without the field we came for. */
export class MalformedError extends Error {
  constructor(readonly what: string) {
    super(`missing ${what}`);
  }
}

export type Identity = "app" | "user";

const quoteScopes = (scopes: string[]) =>
  scopes.length === 0 ? "所需的" : scopes.length === 1 ? `「${scopes[0]}」` : `${scopes.map((s) => `「${s}」`).join("")}中任意一项`;

/** The errors people will actually hit, in words that say what to fix. */
export function explain(error: unknown, identity: Identity): string {
  if (error instanceof NetworkError) return `连不上飞书，请稍后再试：${error.message}`;
  if (error instanceof HttpError) return `飞书暂时没有正常回复（HTTP ${error.status}），请稍后再试。`;
  if (error instanceof MalformedError) return `飞书的回复里没有${error.what}，请稍后再试。`;
  if (!(error instanceof FeishuError)) return error instanceof Error ? error.message : String(error);
  const { code, msg, scopes } = error;
  switch (code) {
    case 99991672:
      return `飞书应用还没有开通${quoteScopes(scopes)}权限：请在飞书开发者后台「权限管理」里开通，然后在「版本管理与发布」里发布新版本。`;
    case 99991679:
      return `你的飞书授权里缺少${quoteScopes(scopes)}权限：请重新用飞书登录并同意授权。如果授权页里没有这一项，请先在开发者后台开通它并发布新版本。`;
    case 99991663:
    case 99991668:
    case 99991677:
      if (identity === "user") return "飞书登录已经过期：请重新用飞书登录。";
      if (code === 99991663) return "飞书应用的访问凭证无效，请稍后再试；一直这样请管理员在 EchoMind「公司管理」里核对这家公司的飞书应用。";
      break;
    case 99991664:
    case 99991665:
      return "飞书应用的访问凭证无效，请稍后再试；一直这样请管理员在 EchoMind「公司管理」里核对这家公司的飞书应用。";
    case 10015:
    case 20002:
    case 99991543:
      return "这家公司飞书应用的 App ID 或 App Secret 不对：请管理员在 EchoMind「公司管理」里更换 App Secret。";
    case 10014:
    case 11210:
    case 20009:
    case 99991662:
    case 99991673:
      return "飞书应用已停用，或者还没有发布到企业里：请在开发者后台检查应用状态，并发布一个版本。";
    case 20010:
      return "你不在这个飞书应用的可用范围里：请在开发者后台「版本管理与发布」里把自己加进可用范围，并发布新版本。";
    case 40004:
    case 40014:
    case 41050:
      return "飞书应用的通讯录权限范围不够：请在开发者后台「权限管理 → 数据权限 → 通讯录权限范围」里选择全部成员，并发布新版本。";
    case 99991400:
    case 190004:
    case 190005:
    case 190010:
      return "飞书接口调用太频繁了，请稍等一会儿再试。";
    case 99991401:
      return "飞书应用开启了 IP 白名单，EchoMind 服务器不在名单里：请在开发者后台「安全设置」里加上 58.87.77.127。";
    case 191002:
      return "你没有这个飞书日历的访问权限。";
    case 194001:
      return "没有权限查看这个日程的参与人：需要日程组织者允许参与人查看参与人列表。";
    case 195100:
      return "这个飞书账号已经离职，或者不在当前企业里：请换一个账号登录。";
    case 1470400:
      return `飞书任务的内容不符合要求：${msg}`;
    case 1470403:
      return `没有权限创建这个飞书任务：${msg}`;
    case 1470500:
      return "飞书创建任务失败：常见原因是负责人不在本企业或账号已停用。请核对负责人后再试。";
  }
  return `飞书接口出错（${code}）：${msg}`;
}

/**
 * The scopes a permission error names: `error.permission_violations[].subject`, or the
 * bracketed list in `msg` ("… One of the following scopes is required: [a, b]").
 */
export function violatedScopes(reply: { msg?: unknown; error?: { permission_violations?: { subject?: unknown }[] } }): string[] {
  let scopes = (reply.error?.permission_violations ?? []).map((v) => v.subject).filter((s): s is string => typeof s === "string");
  if (scopes.length === 0 && typeof reply.msg === "string") {
    const list = /\[([^\]]*)\]/.exec(reply.msg)?.[1];
    if (list) scopes = list.split(",").map((s) => s.trim()).filter((s) => s.includes(":"));
  }
  return [...new Set(scopes)];
}

export const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

type Query = Record<string, string>;

/** fetch says little more than "fetch failed"; the cause says why. */
const describe = (e: unknown): string =>
  e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e);

/** Feishu's JSON, loosely typed: every field is read defensively. */
export type Reply = Record<string, any>;

export class Feishu {
  readonly base: string;
  readonly app: { appId: string; appSecret: string } | null;
  private readonly fetch: Fetch;
  private tenant: { token: string; expiresAt: number } | null = null;
  private tenantPending: Promise<string> | null = null;

  constructor(options: { app: { appId: string; appSecret: string } | null; base?: string; fetch?: Fetch }) {
    this.app = options.app;
    this.base = (options.base ?? OPEN_API).replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  url(path: string[], query: Query = {}): string {
    const url = new URL(`${this.base}/${path.map(encodeURIComponent).join("/")}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** POSTs JSON and returns the parsed reply whatever its code: for endpoints with their own error shape. */
  async postRaw(url: string, json: unknown): Promise<{ status: number; reply: Reply }> {
    let status: number;
    let body: string;
    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(json),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      body = await response.text();
    } catch (e) {
      throw new NetworkError(describe(e));
    }
    try {
      return { status, reply: JSON.parse(body) };
    } catch {
      throw new HttpError(status);
    }
  }

  /** Sends a request and returns the whole reply when its `code` is 0. */
  async send(url: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<Reply> {
    const { token, json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (json !== undefined) headers.set("Content-Type", "application/json; charset=utf-8");
    let status: number;
    let body: string;
    try {
      const response = await this.fetch(url, {
        ...rest,
        headers,
        body: json === undefined ? rest.body : JSON.stringify(json),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      body = await response.text();
    } catch (e) {
      throw new NetworkError(describe(e));
    }
    let reply: Reply;
    try {
      reply = JSON.parse(body);
    } catch {
      throw new HttpError(status);
    }
    if (typeof reply?.code !== "number") throw new HttpError(status);
    if (reply.code !== 0) throw new FeishuError(reply.code, typeof reply.msg === "string" ? reply.msg : "", violatedScopes(reply));
    return reply;
  }

  async get(token: string, path: string[], query: Query = {}): Promise<Reply> {
    return (await this.send(this.url(path, query), { token })).data ?? {};
  }

  /** Every item of a paginated list. */
  async getAll(token: string, path: string[], query: Query = {}): Promise<Reply[]> {
    const items: Reply[] = [];
    let pageToken = "";
    // Bounded, in case a page token ever repeats.
    for (let i = 0; i < 1000; i++) {
      const data = await this.get(token, path, pageToken ? { ...query, page_token: pageToken } : query);
      if (Array.isArray(data.items)) items.push(...data.items);
      if (data.has_more !== true || !text(data.page_token)) break;
      pageToken = data.page_token;
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // The app's own token

  private async requestTenantToken(): Promise<string> {
    if (!this.app) throw new Error("这家公司还没有配置飞书应用：请管理员在「公司管理」里添加。");
    const reply = await this.send(this.url(["auth", "v3", "tenant_access_token", "internal"]), {
      method: "POST",
      json: { app_id: this.app.appId, app_secret: this.app.appSecret },
    });
    const token = text(reply.tenant_access_token);
    if (!token) throw new MalformedError("应用凭证");
    this.tenant = { token, expiresAt: Date.now() + (Number(reply.expire) || 7200) * 1000 };
    return token;
  }

  /** The tenant_access_token, cached until five minutes before it expires; one request at a time. */
  async tenantToken(): Promise<string> {
    if (this.tenant && this.tenant.expiresAt > Date.now() + 300_000) return this.tenant.token;
    this.tenantPending ??= this.requestTenantToken().finally(() => {
      this.tenantPending = null;
    });
    return this.tenantPending;
  }

  /** Runs `op` with the app's token. A token Feishu no longer accepts is replaced once. */
  async asApp<T>(op: (token: string) => Promise<T>): Promise<T> {
    try {
      return await op(await this.tenantToken());
    } catch (e) {
      if (!(e instanceof FeishuError) || (e.code !== 99991663 && e.code !== 99991665)) throw e;
      this.tenant = null;
      return op(await this.tenantToken());
    }
  }
}
