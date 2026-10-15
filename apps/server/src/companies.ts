import { randomInt } from "node:crypto";
import { seal, unseal } from "./crypto";
import type { Sql } from "./db";
import { Feishu, FeishuError, NetworkError, text } from "./feishu/client";
import { SCOPES } from "./feishu/oauth";
import { log } from "./log";

/**
 * The companies on EchoMind. Each reaches Feishu through its own self-built app, whose secret is
 * sealed in `tenants`; people pick their company with its join code before signing in.
 *
 * The app in .env is the default company: it is taken into `tenants` at start-up, after which
 * the 公司管理 page manages its secret like any other. Desktop builds from before join codes
 * sign in without one and land there.
 */

export type App = { appId: string; appSecret: string };

/** A company as the 公司管理 page shows it. */
export type Company = {
  id: string;
  /** The name registered in Feishu; null until Feishu has told us. */
  name: string | null;
  appId: string;
  joinCode: string | null;
  /** People who have signed in at least once. */
  people: number;
  disabled: boolean;
  isDefault: boolean;
  createdAt: string;
};

/** A company someone is signing in to. */
export type Door = { id: string; name: string | null; joinCode: string | null; appId: string; tenantKey: string | null; feishu: Feishu };

/** What a new company's Feishu app needs, in the shape of the console's 批量导入 box. */
export const APP_PERMISSIONS = {
  scopes: {
    tenant: [
      "tenant:tenant:readonly",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:department.base:readonly",
      "contact:user.employee:readonly",
    ],
    user: SCOPES,
  },
};

/** Something about a company the caller can act on: `code` for the desktop, a sentence for people. */
export class CompanyError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** The signed-in Feishu account is not in the company it signed in to. */
export class WrongTenant extends Error {
  constructor() {
    super("这个飞书账号不属于这家公司：请确认加入码，或者换一个飞书账号登录。");
  }
}

/** No 0/O, 1/I/L: codes are read out and typed by hand. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export const newJoinCode = (): string => Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** What people type: any case, with spaces or dashes. */
export const normalizeJoinCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, "");

const aad = (appId: string) => `app-secret:${appId}`;

const uniqueViolation = (e: unknown, column: string): boolean =>
  !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505" && String((e as { constraint_name?: unknown }).constraint_name ?? "").includes(column);

/** Runs `insert` with fresh join codes until one is not taken. */
async function withJoinCode<T>(insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insert(newJoinCode());
    } catch (e) {
      if (!uniqueViolation(e, "join_code") || attempt >= 5) throw e;
    }
  }
}

type Row = {
  id: string;
  name: string | null;
  feishuAppId: string;
  feishuTenantKey: string | null;
  feishuAppSecret: Uint8Array | null;
  joinCode: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  people: number;
};

/** What Feishu says when an app is checked, in words for whoever is adding it. */
function checkFailed(e: unknown): Error {
  if (e instanceof NetworkError) return new CompanyError("feishu_offline", 503, `连不上飞书，请稍后再试：${e.message}`);
  if (!(e instanceof FeishuError)) return e instanceof Error ? e : new Error(String(e));
  switch (e.code) {
    case 10003:
    case 10015:
    case 20002:
    case 50003:
    case 99991543:
      return new CompanyError("app_rejected", 400, "App ID 或 App Secret 不对：请在那家公司的飞书开发者后台「凭证与基础信息」里重新复制。");
    case 10014:
    case 11210:
    case 20009:
    case 99991662:
    case 99991673:
      return new CompanyError("app_unavailable", 400, "这个飞书应用还没有发布，或者已经停用：请在开发者后台发布一个版本，等那家公司的管理员审核通过后再试。");
    case 99991672:
      return new CompanyError("app_scope_missing", 400, "这个飞书应用还没有开通「获取企业信息」（tenant:tenant:readonly）权限：请在开发者后台开通并发布新版本后再试。");
  }
  return new CompanyError("app_check_failed", 400, `飞书没有通过这个应用的检查（${e.code}）：${e.msg}`);
}

export type CompaniesDeps = {
  sql: Sql;
  key: Buffer | null;
  /** The app in .env, if any: the default company. */
  defaultApp: App | null;
  /** open_ids of the people in the default company who manage companies. */
  admins: string[];
  /** For tests: a client against a fake Feishu. */
  makeFeishu?: (app: App) => Feishu;
};

export class Companies {
  /** One client per company, so each keeps its app token; rebuilt when the secret changes. */
  private readonly clients = new Map<string, { sealed: Buffer; feishu: Feishu }>();
  private readonly makeFeishu: (app: App) => Feishu;

  constructor(private readonly deps: CompaniesDeps) {
    this.makeFeishu = deps.makeFeishu ?? ((app) => new Feishu({ app }));
  }

  private get sql(): Sql {
    return this.deps.sql;
  }

  private needKey(): Buffer {
    if (!this.deps.key) throw new Error("服务器还没有配置 ECHOMIND_DATA_KEY，不能保存飞书应用的 App Secret：请管理员处理。");
    return this.deps.key;
  }

  private select(where: "all" | { id: string } | { joinCode: string } | { appId: string }) {
    const filter =
      where === "all"
        ? this.sql``
        : "id" in where
          ? this.sql`where t.id = ${where.id}`
          : "joinCode" in where
            ? this.sql`where t.join_code = ${where.joinCode}`
            : this.sql`where t.feishu_app_id = ${where.appId}`;
    return this.sql<Row[]>`
      select t.id, t.name, t.feishu_app_id, t.feishu_tenant_key, t.feishu_app_secret, t.join_code, t.disabled_at, t.created_at,
        (select count(*)::int from people p join feishu_grants g on g.person_id = p.id where p.tenant_id = t.id) as people
      from tenants t ${filter}
      order by t.created_at`;
  }

  private shown(row: Row): Company {
    return {
      id: row.id,
      name: row.name,
      appId: row.feishuAppId,
      joinCode: row.joinCode,
      people: row.people,
      disabled: !!row.disabledAt,
      isDefault: row.feishuAppId === this.deps.defaultApp?.appId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.select({ id });
    if (!row) throw new CompanyError("not_found", 404, "没有这家公司。");
    return row;
  }

  private secretOf(row: Row): string {
    if (!row.feishuAppSecret) throw new Error("这家公司还没有保存飞书应用的 App Secret：请管理员在「公司管理」里补上。");
    return unseal(this.needKey(), row.feishuAppSecret, aad(row.feishuAppId));
  }

  // -------------------------------------------------------------------------
  // Start-up

  /** Takes the .env app into `tenants` once; from then on the secret saved there wins. */
  async adoptDefault(): Promise<void> {
    const app = this.deps.defaultApp;
    if (!app || !this.deps.key) return;
    const sealed = seal(this.deps.key, app.appSecret, aad(app.appId));
    await withJoinCode(
      (code) => this.sql`
        insert into tenants (feishu_app_id, feishu_app_secret, join_code) values (${app.appId}, ${sealed}, ${code})
        on conflict (feishu_app_id) do update set
          feishu_app_secret = coalesce(tenants.feishu_app_secret, excluded.feishu_app_secret),
          join_code = coalesce(tenants.join_code, excluded.join_code)`,
    );
    const [row] = await this.select({ appId: app.appId });
    if (row && this.secretOf(row) !== app.appSecret) {
      log("warn", "服务器 .env 里的 FEISHU_APP_SECRET 和「公司管理」里保存的不一样，以「公司管理」里的为准");
    }
  }

  /** Asks Feishu for the names not known yet. Best effort: failures are logged. */
  async fillMissingNames(): Promise<void> {
    for (const row of await this.select("all")) {
      if (row.name || !row.feishuAppSecret) continue;
      try {
        await this.check(row.id);
      } catch (e) {
        log("info", "还没读到公司名称", { tenant: row.id, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Using a company

  /** The Feishu client for a company's app. */
  async feishu(tenantId: string): Promise<Feishu> {
    const [row] = await this.sql<{ feishuAppId: string; feishuAppSecret: Uint8Array | null }[]>`
      select feishu_app_id, feishu_app_secret from tenants where id = ${tenantId}`;
    if (!row?.feishuAppSecret) throw new Error("这家公司还没有保存飞书应用的 App Secret：请管理员在「公司管理」里补上。");
    const sealed = Buffer.from(row.feishuAppSecret);
    const cached = this.clients.get(tenantId);
    if (cached?.sealed.equals(sealed)) return cached.feishu;
    const feishu = this.makeFeishu({ appId: row.feishuAppId, appSecret: unseal(this.needKey(), sealed, aad(row.feishuAppId)) });
    this.clients.set(tenantId, { sealed, feishu });
    return feishu;
  }

  /** The company a join code opens. Without a code, the default company. */
  async door(joinCode: string | undefined): Promise<Door> {
    const code = joinCode ? normalizeJoinCode(joinCode) : "";
    let row: Row | undefined;
    if (code) [row] = await this.select({ joinCode: code });
    else if (this.deps.defaultApp) [row] = await this.select({ appId: this.deps.defaultApp.appId });
    else throw new CompanyError("company_required", 400, "请先输入公司加入码。");
    if (!row) {
      throw code
        ? new CompanyError("unknown_company", 404, "没有这个加入码：请向你们公司的 EchoMind 管理员确认。")
        : new CompanyError("company_required", 400, "请先输入公司加入码。");
    }
    if (row.disabledAt) throw new CompanyError("company_disabled", 403, "你们公司的 EchoMind 已停用，请联系管理员。");
    return { id: row.id, name: row.name, joinCode: row.joinCode, appId: row.feishuAppId, tenantKey: row.feishuTenantKey, feishu: await this.feishu(row.id) };
  }

  /** The account signing in must belong to the company. The default company learns its tenant here. */
  async admit(door: Door, tenantKey: string): Promise<void> {
    if (door.tenantKey === tenantKey) return;
    if (door.tenantKey === null) {
      try {
        const [bound] = await this.sql`
          update tenants set feishu_tenant_key = ${tenantKey} where id = ${door.id} and feishu_tenant_key is null returning id`;
        if (bound) return;
      } catch (e) {
        if (!uniqueViolation(e, "tenant_key")) throw e;
        throw new WrongTenant();
      }
      const [row] = await this.sql<{ feishuTenantKey: string | null }[]>`select feishu_tenant_key from tenants where id = ${door.id}`;
      if (row?.feishuTenantKey === tenantKey) return;
    }
    throw new WrongTenant();
  }

  /** Only people in the default company named in ECHOMIND_ADMINS manage companies. */
  async isAdmin(me: { tenantId: string; openId: string }): Promise<boolean> {
    const app = this.deps.defaultApp;
    if (!app || !this.deps.admins.includes(me.openId)) return false;
    const [row] = await this.sql<{ id: string }[]>`select id from tenants where feishu_app_id = ${app.appId}`;
    return row?.id === me.tenantId;
  }

  async joinCodeOf(tenantId: string): Promise<{ name: string | null; joinCode: string | null }> {
    const row = await this.row(tenantId);
    return { name: row.name, joinCode: row.joinCode };
  }

  // -------------------------------------------------------------------------
  // The 公司管理 page

  async list(): Promise<Company[]> {
    return (await this.select("all")).map((row) => this.shown(row));
  }

  /** Asks Feishu which company an app belongs to; this also proves the secret is right. */
  private async inspect(app: App): Promise<{ name: string; tenantKey: string }> {
    const feishu = this.makeFeishu(app);
    let tenant: Record<string, unknown>;
    try {
      tenant = (await feishu.asApp((token) => feishu.get(token, ["tenant", "v2", "tenant", "query"]))).tenant ?? {};
    } catch (e) {
      throw checkFailed(e);
    }
    const tenantKey = text(tenant.tenant_key);
    if (!tenantKey) throw new CompanyError("app_check_failed", 400, "飞书没有返回这个应用所属的企业，请稍后再试。");
    return { name: text(tenant.name) ?? tenantKey, tenantKey };
  }

  async add(input: App): Promise<Company> {
    const key = this.needKey();
    const app = { appId: input.appId.trim(), appSecret: input.appSecret.trim() };
    const [existing] = await this.select({ appId: app.appId });
    if (existing) throw new CompanyError("company_exists", 409, `这个飞书应用已经添加过了${existing.name ? `：${existing.name}` : ""}。`);
    const found = await this.inspect(app);
    const [same] = await this.sql<{ name: string | null }[]>`select name from tenants where feishu_tenant_key = ${found.tenantKey}`;
    if (same) throw new CompanyError("company_exists", 409, `${found.name}已经添加过了（用的是另一个飞书应用），一家公司只需要添加一次。`);
    const sealed = seal(key, app.appSecret, aad(app.appId));
    let id: string;
    try {
      const [inserted] = await withJoinCode(
        (code) => this.sql<{ id: string }[]>`
          insert into tenants (name, feishu_app_id, feishu_tenant_key, feishu_app_secret, join_code)
          values (${found.name}, ${app.appId}, ${found.tenantKey}, ${sealed}, ${code})
          returning id`,
      );
      id = inserted!.id;
    } catch (e) {
      // Added by someone else in the meantime.
      if (uniqueViolation(e, "app_id") || uniqueViolation(e, "tenant_key")) throw new CompanyError("company_exists", 409, `${found.name}已经添加过了。`);
      throw e;
    }
    log("info", "已添加公司", { tenant: id, name: found.name });
    return this.shown(await this.row(id));
  }

  /** Checks a company's app with the secret saved for it, and refreshes its name. */
  async check(id: string): Promise<Company> {
    const row = await this.row(id);
    const found = await this.inspect({ appId: row.feishuAppId, appSecret: this.secretOf(row) });
    await this.record(row, found);
    return this.shown(await this.row(id));
  }

  async replaceSecret(id: string, appSecret: string): Promise<Company> {
    const key = this.needKey();
    const row = await this.row(id);
    const secret = appSecret.trim();
    const found = await this.inspect({ appId: row.feishuAppId, appSecret: secret });
    await this.record(row, found);
    await this.sql`update tenants set feishu_app_secret = ${seal(key, secret, aad(row.feishuAppId))} where id = ${id}`;
    log("info", "已更换公司的 App Secret", { tenant: id });
    return this.shown(await this.row(id));
  }

  /** Saves what Feishu said about an app, which must still be the company's own. */
  private async record(row: Row, found: { name: string; tenantKey: string }): Promise<void> {
    if (row.feishuTenantKey && row.feishuTenantKey !== found.tenantKey) {
      throw new CompanyError("app_check_failed", 400, `这个飞书应用现在属于「${found.name}」，不是添加时的那家公司。`);
    }
    await this.sql`update tenants set name = ${found.name}, feishu_tenant_key = ${found.tenantKey} where id = ${row.id}`;
  }

  /** A disabled company's people are signed out at their next request; enabling lets them sign in again. */
  async setDisabled(id: string, disabled: boolean, by: { tenantId: string }): Promise<Company> {
    const row = await this.row(id);
    if (disabled && id === by.tenantId) throw new CompanyError("own_company", 400, "不能停用你自己所在的公司。");
    await this.sql`update tenants set disabled_at = ${disabled ? new Date() : null} where id = ${row.id}`;
    log("info", disabled ? "已停用公司" : "已启用公司", { tenant: id });
    return this.shown(await this.row(id));
  }
}
