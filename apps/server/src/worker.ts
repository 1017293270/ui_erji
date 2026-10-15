import { Companies } from "./companies";
import { loadConfig } from "./config";
import { beat, connect, migrate } from "./db";
import { LongConnections } from "./feishu/connections";
import { keepGrantsAlive } from "./grants";
import { every, run } from "./lifecycle";
import { log } from "./log";
import { VERSION } from "./version";
import { answerCard } from "./voiceprints";

/**
 * Everything that runs on its own: the heartbeat, keeping Feishu grants alive, and the Feishu
 * long connections (consent card buttons); later the job queue, the morning messages and the
 * task sync. Exactly one worker runs.
 */
run("worker", async () => {
  const config = loadConfig();
  const sql = connect(config.databaseUrl, 5);
  await migrate(sql);

  const companies = new Companies({ sql, key: config.dataKey, defaultApp: config.feishu, admins: config.admins });
  await companies.adoptDefault();
  const grants = { sql, companies, key: config.dataKey };
  const voiceprints = { sql, companies, key: config.dataKey };
  const connections = new LongConnections({
    sql,
    key: config.dataKey,
    handlers: { cardAction: (tenantId, press) => answerCard(voiceprints, tenantId, press) },
  });

  const stopBeat = every(30_000, "心跳", () => beat(sql, "worker"));
  const stopGrants = every(3_600_000, "刷新飞书授权", async () => {
    const result = await keepGrantsAlive(grants);
    if (result.refreshed || result.signedOut || result.failed) log("info", "飞书授权已刷新", result);
  });
  // Companies added, disabled or given a new secret on the 公司管理 page are picked up within a minute.
  const stopConnections = every(60_000, "飞书长连接", () => connections.reconcile());
  log("info", "worker 已启动", { version: VERSION });

  return async () => {
    await Promise.all([stopBeat(), stopGrants(), stopConnections()]);
    connections.closeAll();
    await sql.end({ timeout: 5 });
  };
});
