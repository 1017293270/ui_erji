import { allDayTimestamp } from "../dates";
import { type Feishu, MalformedError, text } from "./client";

export type NewTask = { title: string; description?: string | null; due?: string | null; assigneeId: string };
export type CreatedTask = { guid: string; url?: string };

/** Feishu allows 3000 characters for both the title and the description. */
const clip = (s: string) => [...s].slice(0, 3000).join("");

/** The task v2 body. Throws a RangeError that says what to fix. */
export function taskBody(task: NewTask): Record<string, unknown> {
  const title = task.title.trim();
  if (!title) throw new RangeError("这条待办没有标题，不能推送到飞书。");
  const assignee = task.assigneeId.trim();
  if (!assignee.startsWith("ou_")) throw new RangeError("这条待办的负责人不在飞书通讯录里，不能推送到飞书任务。");
  const body: Record<string, unknown> = {
    summary: clip(title),
    members: [{ id: assignee, type: "user", role: "assignee" }],
    origin: { platform_i18n_name: { zh_cn: "EchoMind 会议纪要", en_us: "EchoMind" } },
  };
  const description = task.description?.trim();
  if (description) body.description = clip(description);
  const due = task.due?.trim();
  if (due) {
    const timestamp = allDayTimestamp(due);
    if (!timestamp) throw new RangeError(`截止日期「${due}」不是 YYYY-MM-DD 格式的日期。`);
    body.due = { timestamp, is_all_day: true };
  }
  return body;
}

export async function createTask(feishu: Feishu, accessToken: string, body: Record<string, unknown>): Promise<CreatedTask> {
  const reply = await feishu.send(feishu.url(["task", "v2", "tasks"], { user_id_type: "open_id" }), {
    method: "POST",
    token: accessToken,
    json: body,
  });
  const guid = text(reply.data?.task?.guid);
  if (!guid) throw new MalformedError("任务 ID");
  const url = text(reply.data?.task?.url);
  return url ? { guid, url } : { guid };
}
