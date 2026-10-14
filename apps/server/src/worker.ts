import { loadConfig } from "./config";
import { beat, connect, migrate } from "./db";
import { every, run } from "./lifecycle";
import { log } from "./log";
import { VERSION } from "./version";

/**
 * Everything that runs on its own: for now the heartbeat; later the Feishu long connection,
 * the job queue, the morning messages and the task sync. Exactly one worker runs.
 */
run("worker", async () => {
  const config = loadConfig();
  const sql = connect(config.databaseUrl, 5);
  await migrate(sql);

  const stopBeat = every(30_000, "心跳", () => beat(sql, "worker"));
  log("info", "worker 已启动", { version: VERSION });

  return async () => {
    await stopBeat();
    await sql.end({ timeout: 5 });
  };
});
