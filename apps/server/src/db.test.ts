import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beat, migrate, type Sql } from "./db";
import { Feishu } from "./feishu/client";
import { checkHealth, createApp } from "./http";
import { freshDb, hasDb } from "./testing/db";

const stubs = { feishu: new Feishu({ app: null }), dataKey: null, llm: { apiKey: null, baseUrl: "https://llm.test", model: "m" } };

describe.skipIf(!hasDb)("database", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let sql: Sql;
  beforeAll(async () => {
    db = await freshDb();
    sql = db.sql;
  });
  afterAll(() => db?.drop());

  it("applies each migration once, even when two processes start together", async () => {
    const dir = await mkdtemp(join(tmpdir(), "echomind-migrations-"));
    await writeFile(join(dir, "0001_a.sql"), "create table a (id int); insert into a values (1);");
    await writeFile(join(dir, "0002_b.sql"), "create table b (id int);");
    await writeFile(join(dir, "notes.txt"), "ignored");
    const runs = await Promise.all([migrate(sql, dir), migrate(sql, dir), migrate(sql, dir)]);
    expect(runs.flat().sort()).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await migrate(sql, dir)).toEqual([]);
  });

  it("reports the worker stale until it beats, and again after three missed beats", async () => {
    const pool = db.sql;
    expect(await checkHealth(pool)).toMatchObject({ ok: false, db: "ok", worker: "stale", workerBeatSecondsAgo: null });
    await beat(pool, "worker");
    expect(await checkHealth(pool)).toMatchObject({ ok: true, worker: "ok", workerBeatSecondsAgo: 0 });
    await pool`update heartbeats set beat_at = now() - interval '2 minutes' where name = 'worker'`;
    expect(await checkHealth(pool)).toMatchObject({ ok: false, worker: "stale", workerBeatSecondsAgo: 120 });
  });

  it("serves /healthz with 200 or 503", async () => {
    const app = createApp({ sql, version: "test", ...stubs });
    await beat(sql, "worker");
    const ok = await app.request("/healthz");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, db: "ok", worker: "ok", workerBeatSecondsAgo: 0, version: "test" });
    await sql`update heartbeats set beat_at = now() - interval '5 minutes'`;
    expect((await app.request("/healthz")).status).toBe(503);
  });
});

describe("http", () => {
  it("answers unknown paths with a JSON error", async () => {
    const app = createApp({ sql: {} as Sql, version: "test", ...stubs });
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "没有这个接口。" } });
  });

  it("reports the database down instead of throwing", async () => {
    const broken = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as Sql;
    const res = await createApp({ sql: broken, version: "test", ...stubs }).request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "down" });
  });
});
