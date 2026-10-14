import { Hono } from "hono";
import type { Sql } from "./db";
import { log } from "./log";

/** Every error body: a code for the desktop to branch on, and a Chinese sentence that says what to do. */
export type ApiError = { error: { code: string; message: string } };

export const fail = (code: string, message: string): ApiError => ({ error: { code, message } });

/** The worker beats every 30 s; three missed beats and it counts as down. */
export const WORKER_STALE_SECONDS = 90;

export type Health = {
  ok: boolean;
  db: "ok" | "down";
  worker: "ok" | "stale" | "unknown";
  workerBeatSecondsAgo: number | null;
};

export async function checkHealth(sql: Sql): Promise<Health> {
  try {
    const [row] = await sql<{ age: number | null }[]>`
      select extract(epoch from now() - max(beat_at))::float8 as age from heartbeats where name = 'worker'`;
    const age = row?.age ?? null;
    const fresh = age !== null && age < WORKER_STALE_SECONDS;
    return { ok: fresh, db: "ok", worker: fresh ? "ok" : "stale", workerBeatSecondsAgo: age === null ? null : Math.round(age) };
  } catch (err) {
    log("warn", "健康检查连不上数据库", { err });
    return { ok: false, db: "down", worker: "unknown", workerBeatSecondsAgo: null };
  }
}

export function createApp(deps: { sql: Sql; version: string }): Hono {
  const app = new Hono();

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === "/healthz") return;
    log("info", "请求", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) });
  });

  app.get("/healthz", async (c) => {
    const health = await checkHealth(deps.sql);
    return c.json({ ...health, version: deps.version }, health.ok ? 200 : 503);
  });

  app.notFound((c) => c.json(fail("not_found", "没有这个接口。"), 404));
  app.onError((err, c) => {
    log("error", "请求出错", { method: c.req.method, path: c.req.path, err });
    return c.json(fail("internal", "服务端出错了，请稍后再试。"), 500);
  });

  return app;
}
