import { dayLabel, timeOfDay, type Meeting } from "@echomind/shared";
import { feishuCreateTask, type NewFeishuTask } from "./native";
import type { TodoItem } from "./store";

/**
 * The 飞书 task for a todo. Owners in the company get the task themselves;
 * a todo for someone outside becomes a 「跟进」 reminder for the person who recorded.
 */
export function taskFor(todo: TodoItem, meeting: Meeting, me: string, nameOf: (id: string | null) => string | undefined): NewFeishuTask {
  const quotes = (meeting.transcript?.segments ?? [])
    .filter((s) => todo.evidence.includes(s.id))
    .slice(0, 2)
    .map((s) => `“${s.text.length > 120 ? `${s.text.slice(0, 120)}…` : s.text}”`);
  const lines = [
    todo.detail,
    todo.external ? `对方：${nameOf(todo.ownerPersonId) ?? todo.ownerMention ?? "外部联系人"}` : null,
    `来自会议「${meeting.title}」· ${dayLabel(meeting.startedAt)} ${timeOfDay(meeting.startedAt)}`,
    quotes.length ? `会上原话：\n${quotes.join("\n")}` : null,
    "由 EchoMind 整理",
  ];
  return {
    title: todo.external ? `跟进：${todo.title}` : todo.title,
    description: lines.filter(Boolean).join("\n"),
    due: todo.due ?? undefined,
    assigneeId: todo.external || !todo.ownerPersonId ? me : todo.ownerPersonId,
  };
}

/** Creates the tasks one by one and stops at the first failure, so trying again never makes duplicates. */
export async function pushToFeishu(
  todos: TodoItem[],
  meeting: Meeting,
  me: string,
  nameOf: (id: string | null) => string | undefined,
): Promise<{ taskIds: Record<string, string>; error?: string }> {
  const taskIds: Record<string, string> = {};
  for (const todo of todos) {
    try {
      taskIds[todo.id] = (await feishuCreateTask(taskFor(todo, meeting, me, nameOf))).guid;
    } catch (e) {
      return { taskIds, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { taskIds };
}
