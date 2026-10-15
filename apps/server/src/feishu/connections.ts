import * as Lark from "@larksuiteoapi/node-sdk";
import { unseal } from "../crypto";
import type { Sql } from "../db";
import { log } from "../log";

/**
 * Feishu's long connections, one per company's app: how Feishu reaches the server (card button
 * presses) without a public address or a domain. Only the worker opens them: when one app has
 * several connections, Feishu hands each event to just one of them, at random.
 *
 * For callbacks to come, each app's developer console needs 「事件与回调 → 回调配置」 set to the
 * long connection, with card.action.trigger (卡片回传交互) added. The console only accepts the
 * long connection while one is open, so the worker connects every company's app regardless.
 */

/** A button pressed on a card the bot sent. */
export type CardPress = { operatorOpenId: string | undefined; value: unknown };

export type Handlers = {
  /** Its return value goes back to Feishu: a toast, and the card in its new state. */
  cardAction: (tenantId: string, press: CardPress) => Promise<unknown>;
};

/** What a connection needs from the SDK; tests stand in for it. */
export type Opener = (app: { appId: string; appSecret: string }, handle: (event: unknown) => Promise<unknown>, events: ConnectionEvents) => { close: () => void };
type ConnectionEvents = { logger: Lark.Logger; onReady: () => void; onFailed: (err: Error) => void };

/** A connection that gave up (the app was refused, or retries ran out) is tried again after this. */
const RETRY_FAILED_MS = 10 * 60_000;
/**
 * A connection that does not open in this long, or does not answer a ping in PING_TIMEOUT_S, is
 * dropped and opened again. Without them a gateway that stops answering, but keeps the socket
 * open, would silently end that company's card presses.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_S = 30;
/** The same SDK complaint is logged once in this long. */
const QUIET_MS = 30 * 60_000;

const openWithSdk: Opener = (app, handle, events) => {
  const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn, logger: events.logger }).register({
    "card.action.trigger": (data: unknown) => handle(data),
  });
  const client = new Lark.WSClient({
    ...app,
    loggerLevel: Lark.LoggerLevel.warn,
    logger: events.logger,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    wsConfig: { pingTimeout: PING_TIMEOUT_S },
    onReady: events.onReady,
    onError: events.onFailed,
  });
  client.start({ eventDispatcher: dispatcher }).catch((e: unknown) => events.onFailed(e instanceof Error ? e : new Error(String(e))));
  return { close: () => client.close({ force: true }) };
};

/** The SDK's logger, quieted: warnings and errors only, each message once in a while. */
function sdkLogger(tenantId: string): Lark.Logger {
  const said = new Map<string, number>();
  const say = (...parts: unknown[]) => {
    const text = parts
      .map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ")
      .slice(0, 300);
    const now = Date.now();
    if ((said.get(text) ?? 0) > now - QUIET_MS) return;
    if (said.size > 200) said.clear();
    said.set(text, now);
    log("warn", "飞书长连接", { tenant: tenantId, detail: text });
  };
  const nothing = () => {};
  return { error: say, warn: say, info: nothing, debug: nothing, trace: nothing };
}

type Connection = { sealed: Buffer; close: () => void; failedAt: number | null };

export class LongConnections {
  private readonly open = new Map<string, Connection>();
  private readonly opener: Opener;

  constructor(private readonly deps: { sql: Sql; key: Buffer | null; handlers: Handlers; opener?: Opener }) {
    this.opener = deps.opener ?? openWithSdk;
  }

  /** Companies with a connection, for tests and health checks. */
  get tenants(): string[] {
    return [...this.open.keys()];
  }

  /** A connection for every company in use, opened again when its secret changed; the rest closed. */
  async reconcile(): Promise<void> {
    const key = this.deps.key;
    if (!key) return;
    const rows = await this.deps.sql<{ id: string; feishuAppId: string; feishuAppSecret: Uint8Array }[]>`
      select id, feishu_app_id, feishu_app_secret from tenants where disabled_at is null and feishu_app_secret is not null`;
    const wanted = new Set(rows.map((r) => r.id));
    for (const id of this.open.keys()) if (!wanted.has(id)) this.close(id);
    for (const row of rows) {
      const sealed = Buffer.from(row.feishuAppSecret);
      const current = this.open.get(row.id);
      const stale = !current || !current.sealed.equals(sealed) || (current.failedAt !== null && current.failedAt < Date.now() - RETRY_FAILED_MS);
      if (!stale) continue;
      this.close(row.id);
      let appSecret: string;
      try {
        appSecret = unseal(key, sealed, `app-secret:${row.feishuAppId}`);
      } catch {
        log("warn", "解不开这家公司的 App Secret，飞书长连接没有打开", { tenant: row.id });
        continue;
      }
      this.connect(row.id, { appId: row.feishuAppId, appSecret }, sealed);
    }
  }

  private connect(tenantId: string, app: { appId: string; appSecret: string }, sealed: Buffer): void {
    const connection: Connection = { sealed, close: () => {}, failedAt: null };
    const handle = async (event: unknown) => {
      const data = (event ?? {}) as { operator?: { open_id?: string }; action?: { value?: unknown } };
      try {
        return await this.deps.handlers.cardAction(tenantId, { operatorOpenId: data.operator?.open_id, value: data.action?.value });
      } catch (e) {
        log("error", "处理飞书卡片按钮出错", { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
        return { toast: { type: "error", content: "EchoMind 暂时没能处理，请稍后再点一次。" } };
      }
    };
    const failed = (err: Error) => {
      connection.failedAt = Date.now();
      log("warn", "飞书长连接没有连上，稍后重试", { tenant: tenantId, err: err.message });
    };
    try {
      connection.close = this.opener(app, handle, {
        logger: sdkLogger(tenantId),
        onReady: () => {
          connection.failedAt = null;
          log("info", "飞书长连接已连上", { tenant: tenantId });
        },
        onFailed: failed,
      }).close;
    } catch (e) {
      failed(e instanceof Error ? e : new Error(String(e)));
    }
    this.open.set(tenantId, connection);
  }

  private close(tenantId: string): void {
    const connection = this.open.get(tenantId);
    if (!connection) return;
    this.open.delete(tenantId);
    try {
      connection.close();
    } catch {
      // Already closed.
    }
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
