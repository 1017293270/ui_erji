/**
 * One JSON object per line on stdout (errors on stderr); Docker keeps and rotates them.
 * Messages are short Chinese phrases for whoever runs the server; fields carry the details.
 * Never pass a token, secret or message body in `fields`.
 */
type Level = "info" | "warn" | "error";

function serialize(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Tests stay quiet unless ECHOMIND_TEST_LOGS is set. */
const silent = !!process.env.VITEST && !process.env.ECHOMIND_TEST_LOGS;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (silent) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, serialize);
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}
