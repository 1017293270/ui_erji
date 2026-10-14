import { log } from "./log";

/**
 * Process plumbing shared by the api and the worker: one clean shutdown on SIGTERM/SIGINT
 * (docker compose stop), and a crash on anything unexpected so Docker restarts us in a known state.
 */
export function run(name: string, start: () => Promise<() => Promise<void>>): void {
  let stop: (() => Promise<void>) | null = null;
  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", `${name} 正在停止`, { signal });
    const timer = setTimeout(() => {
      log("error", `${name} 停止超时，强制退出`);
      process.exit(1);
    }, 10_000);
    timer.unref();
    try {
      await stop?.();
    } catch (err) {
      log("error", `${name} 停止时出错`, { err });
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => {
    log("error", `${name} 有未处理的异常，退出后由 Docker 重启`, { err });
    process.exit(1);
  });

  start().then(
    (fn) => {
      stop = fn;
    },
    (err) => {
      log("error", `${name} 启动失败`, { err: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    },
  );
}

/**
 * Calls `fn` now and then `ms` after each call finishes, so slow runs never overlap.
 * Errors are logged and the loop keeps going. Returns a function that stops it and
 * waits for a run in progress.
 */
export function every(ms: number, label: string, fn: () => Promise<void>): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const tick = () => {
    running = fn()
      .catch((err) => log("error", `${label} 出错`, { err }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, ms);
      });
  };
  tick();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
