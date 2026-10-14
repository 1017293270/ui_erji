import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { log } from "./log";

export type Sql = postgres.Sql;

/** Columns are snake_case in SQL and camelCase in TypeScript; postgres.camel maps both ways. */
export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    transform: postgres.camel,
    onnotice: () => {},
  });
}

/** migrations/ sits next to src/ and dist/, so the same path works from source and from the bundle. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Any fixed number: both processes start together and must not migrate at the same time. */
const MIGRATION_LOCK = 4_271_903;

/**
 * Applies the numbered .sql files that have not run yet, in order, in one transaction.
 * Returns the files it applied.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(`${dir}/${file}`, "utf8")).simple();
      await tx`insert into schema_migrations (version) values (${file})`;
      applied.push(file);
    }
  });
  if (applied.length) log("info", "数据库已迁移", { applied });
  return applied;
}

/** Records that a long-running process is alive; /healthz reads it. */
export async function beat(sql: Sql, name: string): Promise<void> {
  await sql`insert into heartbeats (name, beat_at) values (${name}, now())
            on conflict (name) do update set beat_at = excluded.beat_at`;
}
