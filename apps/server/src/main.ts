import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createApp } from "./http";
import { run } from "./lifecycle";
import { log } from "./log";
import { VERSION } from "./version";

/** The HTTPS API the desktop app talks to. */
run("api", async () => {
  const config = loadConfig();
  if (config.production && !config.tls) throw new Error("正式环境必须设置 TLS_CERT 和 TLS_KEY，不能用明文 HTTP。");

  const sql = connect(config.databaseUrl);
  await migrate(sql);

  const app = createApp({ sql, version: VERSION });
  const tls = config.tls && { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) };
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
      ...(tls ? { createServer, serverOptions: { ...tls, minVersion: "TLSv1.2" as const } } : {}),
    },
    (info) => log("info", "api 已启动", { port: info.port, https: !!tls, version: VERSION }),
  );

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.end({ timeout: 5 });
  };
});
