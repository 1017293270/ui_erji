import type { Sql } from "./db";
import { type Feishu, NetworkError } from "./feishu/client";
import { type DirectoryPerson, fetchDirectory } from "./feishu/directory";
import type { Profile } from "./feishu/oauth";
import { log } from "./log";

/** A tenant's directory younger than this answers without asking Feishu. */
const DIRECTORY_MAX_AGE_MS = 12 * 3_600_000;

/** Tenant directories being walked right now: a second caller waits for the same walk. */
const walking = new Map<string, Promise<void>>();

/** The person signing in, known from now on even before the directory lists them. */
export async function upsertSignedIn(sql: Sql, tenantId: string, profile: Profile): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into people (tenant_id, open_id, name) values (${tenantId}, ${profile.openId}, ${profile.name})
    on conflict (tenant_id, open_id) do update set name = excluded.name, updated_at = now()
    returning id`;
  return row!.id;
}

export async function syncDirectory(sql: Sql, feishu: Feishu, tenantId: string): Promise<number> {
  const { people, hints } = await feishu.asApp((token) => fetchDirectory(feishu, token));
  for (const hint of hints) log("info", `飞书通讯录：开通「${hint.scope}」后才能读到${hint.unlocks}`);
  await sql.begin(async (tx) => {
    const rows = people.map((p, i) => ({
      tenantId,
      openId: p.id,
      name: p.name,
      department: p.department ?? null,
      title: p.title ?? null,
      aliases: p.aliases,
      listed: true,
      sortOrder: i,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx`
        insert into people ${tx(rows.slice(i, i + 1000))}
        on conflict (tenant_id, open_id) do update set
          name = excluded.name, department = excluded.department, title = excluded.title, aliases = excluded.aliases,
          listed = true, sort_order = excluded.sort_order, updated_at = now()`;
    }
    await tx`
      update people set listed = false, updated_at = now()
      where tenant_id = ${tenantId} and listed and not (open_id = any(${people.map((p) => p.id)}::text[]))`;
    await tx`update tenants set directory_synced_at = now() where id = ${tenantId}`;
  });
  log("info", "飞书通讯录已同步", { tenant: tenantId, people: people.length });
  return people.length;
}

export async function listDirectory(sql: Sql, tenantId: string): Promise<DirectoryPerson[]> {
  const rows = await sql<{ openId: string; name: string; department: string | null; title: string | null; aliases: string[] }[]>`
    select open_id, name, department, title, aliases from people
    where tenant_id = ${tenantId} and listed order by sort_order, name`;
  return rows.map((r) => {
    const person: DirectoryPerson = { id: r.openId, name: r.name, feishuOpenId: r.openId, aliases: r.aliases, external: false };
    if (r.department) person.department = r.department;
    if (r.title) person.title = r.title;
    return person;
  });
}

/**
 * Everyone in the tenant. Without `refresh` a directory younger than 12 hours answers. When
 * Feishu cannot be reached, or a non-refresh walk fails, the last directory answers; an explicit
 * refresh that Feishu rejects throws, so the person sees what to fix.
 */
export async function directory(sql: Sql, feishu: Feishu, tenantId: string, refresh: boolean): Promise<DirectoryPerson[]> {
  const [tenant] = await sql<{ directorySyncedAt: Date | null }[]>`select directory_synced_at from tenants where id = ${tenantId}`;
  const syncedAt = tenant?.directorySyncedAt?.getTime() ?? 0;
  if (!refresh && syncedAt > Date.now() - DIRECTORY_MAX_AGE_MS) return listDirectory(sql, tenantId);

  let walk = walking.get(tenantId);
  if (!walk) {
    walk = syncDirectory(sql, feishu, tenantId)
      .then(() => undefined)
      .finally(() => walking.delete(tenantId));
    walking.set(tenantId, walk);
  }
  try {
    await walk;
  } catch (e) {
    if (!syncedAt || (refresh && !(e instanceof NetworkError))) throw e;
    log("warn", "读取飞书通讯录失败，先用上次的结果", { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
  }
  return listDirectory(sql, tenantId);
}
