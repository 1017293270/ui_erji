import { Companies } from "./companies";
import { loadConfig } from "./config";
import { beat, connect, migrate } from "./db";
import { keepGrantsAlive } from "./grants";
import { every, run } from "./lifecycle";
import { log } from "./log";
import { VERSION } from "./version";

/**
 * Everything that runs on its own: the heartbeat and keeping Feishu grants alive; later the
 * Feishu long connection, the job queue, the morning messages and the task sync.
 * Exactly one worker runs.
 */
run("worker", async () => {
  const config = loadConfig();
  const sql = connect(config.databaseUrl, 5);
  await migrate(sql);

  const companies = new Companies({ sql, key: config.dataKey, defaultApp: config.feishu, admins: config.admins });
  await companies.adoptDefault();
  const grants = { sql, companies, key: config.dataKey };

  const stopBeat = every(30_000, "心跳", () => beat(sql, "worker"));
  const stopGrants = every(3_600_000, "刷新飞书授权", async () => {
    const result = await keepGrantsAlive(grants);
    if (result.refreshed || result.signedOut || result.failed) log("info", "飞书授权已刷新", result);
  });
  log("info", "worker 已启动", { version: VERSION });

  return async () => {
    await Promise.all([stopBeat(), stopGrants()]);
    await sql.end({ timeout: 5 });
  };
});
