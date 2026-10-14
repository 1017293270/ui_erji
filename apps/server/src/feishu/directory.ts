import { type Feishu, FeishuError, type Reply, text } from "./client";

/** Someone in the directory, as the desktop's `Person` (packages/shared): `id` is the open_id. */
export type DirectoryPerson = {
  id: string;
  name: string;
  feishuOpenId: string;
  department?: string;
  title?: string;
  aliases: string[];
  external: false;
};

/** An optional scope the app lacks, judged by fields that came back empty for everyone. */
export type Hint = { scope: string; unlocks: string };

/**
 * Departments from the walk and `[department the user was listed under, user]` pairs, into
 * people. Fields guarded by scopes the app may not have are left out rather than failing.
 */
export function buildDirectory(departments: Reply[], members: [string, Reply][]): { people: DirectoryPerson[]; hints: Hint[] } {
  const names = new Map<string, string>();
  for (const d of departments) {
    const id = text(d.open_department_id);
    const name = text(d.name);
    if (id && name) names.set(id, name);
  }
  const hints: Hint[] = [];
  if (departments.length > 0 && names.size === 0) hints.push({ scope: "contact:department.base:readonly", unlocks: "部门名称" });
  if (members.length > 0 && members.every(([, user]) => user.status === undefined)) {
    hints.push({ scope: "contact:user.employee:readonly", unlocks: "职务和在职状态" });
  }

  const seen = new Set<string>();
  let nameless = false;
  const people: DirectoryPerson[] = [];
  for (const [listedUnder, user] of members) {
    const openId = text(user.open_id);
    if (!openId) continue;
    if (["is_resigned", "is_exited", "is_frozen"].some((flag) => user.status?.[flag] === true)) continue;
    const name = text(user.name);
    if (!name) {
      nameless = true;
      continue;
    }
    if (seen.has(openId)) continue;
    seen.add(openId);
    // The user's first department when the app may read it, else where the walk found them.
    const departmentId = (Array.isArray(user.department_ids) && typeof user.department_ids[0] === "string" ? user.department_ids[0] : null) ?? listedUnder;
    const aliases: string[] = [];
    for (const alias of [text(user.en_name), text(user.nickname)]) {
      if (alias && alias !== name && !aliases.includes(alias)) aliases.push(alias);
    }
    const person: DirectoryPerson = { id: openId, name, feishuOpenId: openId, aliases, external: false };
    const department = names.get(departmentId);
    if (department) person.department = department;
    const title = text(user.job_title);
    if (title) person.title = title;
    people.push(person);
  }
  if (nameless) hints.push({ scope: "contact:user.base:readonly", unlocks: "成员姓名" });
  return { people, hints };
}

const DEPARTMENTS = { page_size: "50", department_id_type: "open_department_id" };

/** The departments under the root, for tenants too big for one recursive call (43010). */
async function departmentsLevelByLevel(feishu: Feishu, token: string): Promise<Reply[]> {
  const all: Reply[] = [];
  const queue = ["0"];
  for (let parent = queue.pop(); parent !== undefined; parent = queue.pop()) {
    const children = await feishu.getAll(token, ["contact", "v3", "departments", parent, "children"], DEPARTMENTS);
    for (const d of children) if (text(d.open_department_id)) queue.push(d.open_department_id);
    all.push(...children);
  }
  return all;
}

/** Walks the org chart from the root department `0` and lists each department's members. */
export async function fetchDirectory(feishu: Feishu, token: string): Promise<{ people: DirectoryPerson[]; hints: Hint[] }> {
  let departments: Reply[];
  try {
    departments = await feishu.getAll(token, ["contact", "v3", "departments", "0", "children"], { fetch_child: "true", ...DEPARTMENTS });
  } catch (e) {
    if (!(e instanceof FeishuError && e.code === 43010)) throw e;
    departments = await departmentsLevelByLevel(feishu, token);
  }
  const members: [string, Reply][] = [];
  const ids = ["0", ...departments.map((d) => text(d.open_department_id)).filter((id): id is string => !!id)];
  for (const department of ids) {
    const users = await feishu.getAll(token, ["contact", "v3", "users", "find_by_department"], {
      department_id: department,
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: "50",
    });
    for (const user of users) members.push([department, user]);
  }
  return buildDirectory(departments, members);
}
