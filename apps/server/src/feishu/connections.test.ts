import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seal } from "../crypto";
import type { Sql } from "../db";
import { freshDb, hasDb } from "../testing/db";
import { type CardPress, LongConnections, type Opener } from "./connections";

const KEY = randomBytes(32);

describe.skipIf(!hasDb)("long connections", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let sql: Sql;
  beforeAll(async () => {
    db = await freshDb();
    sql = db.sql;
  });
  afterAll(() => db?.drop());

  it("keeps one connection per company in use, and passes card presses on", async () => {
    const opened: { appId: string; appSecret: string; closed: boolean; press: (event: unknown) => Promise<unknown> }[] = [];
    const opener: Opener = (app, handle) => {
      const connection = { ...app, closed: false, press: handle };
      opened.push(connection);
      return { close: () => void (connection.closed = true) };
    };
    const presses: [string, CardPress][] = [];
    const connections = new LongConnections({
      sql,
      key: KEY,
      opener,
      handlers: {
        cardAction: async (tenantId, press) => {
          presses.push([tenantId, press]);
          return { toast: { type: "success", content: "ok" } };
        },
      },
    });
    const add = async (appId: string, secret: string | null) => {
      const sealed = secret ? seal(KEY, secret, `app-secret:${appId}`) : null;
      const [row] = await sql<{ id: string }[]>`insert into tenants (feishu_app_id, feishu_app_secret) values (${appId}, ${sealed}) returning id`;
      return row!.id;
    };
    const a = await add("cli_a", "secret-a");
    const b = await add("cli_b", "secret-b");
    await add("cli_nosecret", null);

    await connections.reconcile();
    expect(opened.map((c) => [c.appId, c.appSecret])).toEqual([["cli_a", "secret-a"], ["cli_b", "secret-b"]]);
    await connections.reconcile();
    expect(opened).toHaveLength(2);

    const reply = await opened[0]!.press({ operator: { open_id: "ou_x" }, action: { value: { voiceprint: "agree", person: "ou_x" } } });
    expect(reply).toEqual({ toast: { type: "success", content: "ok" } });
    expect(presses).toEqual([[a, { operatorOpenId: "ou_x", value: { voiceprint: "agree", person: "ou_x" } }]]);

    // A new secret opens a new connection; a disabled company's closes.
    await sql`update tenants set feishu_app_secret = ${seal(KEY, "secret-a2", "app-secret:cli_a")} where id = ${a}`;
    await sql`update tenants set disabled_at = now() where id = ${b}`;
    await connections.reconcile();
    expect(opened.map((c) => [c.appSecret, c.closed])).toEqual([["secret-a", true], ["secret-b", true], ["secret-a2", false]]);
    expect(connections.tenants).toEqual([a]);

    connections.closeAll();
    expect(opened[2]!.closed).toBe(true);
  });
});
