import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { connect, migrate, type Sql } from "../db";

/** Set by scripts/test-db.sh. Without it the database tests are skipped. */
const url = process.env.TEST_DATABASE_URL;
export const hasDb = !!url;

/** A brand-new, migrated database for one test file. `drop` removes it. */
export async function freshDb(): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await admin.unsafe(`create database ${name}`);
  const own = new URL(url);
  own.pathname = `/${name}`;
  const sql = connect(own.toString(), 4);
  await migrate(sql);
  return {
    sql,
    url: own.toString(),
    drop: async () => {
      await sql.end({ timeout: 1 });
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
