import { z } from "zod";

/**
 * Settings from the environment, read once at start. Secrets live here and nowhere else;
 * nothing in this module is logged, and errors name the variable, never its value.
 */

/** An unset variable and an empty one mean the same thing. */
const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const Env = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string({ error: "缺少 DATABASE_URL（PostgreSQL 连接串）。" }).min(1, "缺少 DATABASE_URL（PostgreSQL 连接串）。"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  /** PEM files for HTTPS. Required in production; without them development serves plain HTTP. */
  TLS_CERT: optional,
  TLS_KEY: optional,
  FEISHU_APP_ID: optional,
  FEISHU_APP_SECRET: optional,
  DEEPSEEK_API_KEY: optional,
  DEEPSEEK_BASE_URL: z.preprocess((v) => v || undefined, z.url().default("https://api.deepseek.com")),
  DEEPSEEK_MODEL: z.preprocess((v) => v || undefined, z.string().default("deepseek-flash")),
  /** 32 random bytes, base64: encrypts Feishu tokens at rest. */
  ECHOMIND_DATA_KEY: optional,
});

export type Config = {
  production: boolean;
  databaseUrl: string;
  host: string;
  port: number;
  tls: { cert: string; key: string } | null;
  feishu: { appId: string; appSecret: string } | null;
  deepseek: { apiKey: string | null; baseUrl: string; model: string };
  dataKey: Buffer | null;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" "));
  const e = parsed.data;
  const production = e.NODE_ENV === "production";

  if (!!e.TLS_CERT !== !!e.TLS_KEY) throw new Error("TLS_CERT 和 TLS_KEY 要一起设置。");
  if (!!e.FEISHU_APP_ID !== !!e.FEISHU_APP_SECRET) throw new Error("FEISHU_APP_ID 和 FEISHU_APP_SECRET 要一起设置。");

  let dataKey: Buffer | null = null;
  if (e.ECHOMIND_DATA_KEY) {
    dataKey = Buffer.from(e.ECHOMIND_DATA_KEY, "base64");
    if (dataKey.length !== 32) throw new Error("ECHOMIND_DATA_KEY 必须是 32 字节随机数的 base64（openssl rand -base64 32）。");
  }

  return {
    production,
    databaseUrl: e.DATABASE_URL,
    host: e.HOST,
    port: e.PORT,
    tls: e.TLS_CERT && e.TLS_KEY ? { cert: e.TLS_CERT, key: e.TLS_KEY } : null,
    feishu: e.FEISHU_APP_ID && e.FEISHU_APP_SECRET ? { appId: e.FEISHU_APP_ID, appSecret: e.FEISHU_APP_SECRET } : null,
    deepseek: { apiKey: e.DEEPSEEK_API_KEY ?? null, baseUrl: e.DEEPSEEK_BASE_URL.replace(/\/+$/, ""), model: e.DEEPSEEK_MODEL },
    dataKey,
  };
}
