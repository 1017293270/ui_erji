import { Check, ExternalLink, Send } from "lucide-react";
import type { OwnerBasis } from "@echomind/shared";
import { cn } from "@echomind/ui";
import { dueLabel } from "../lib/dates";
import { href } from "../lib/router";
import { useStore, type TodoItem } from "../lib/store";
import { Avatar, Badge, TodoStatusBadge } from "./ui";

/** A round check that marks a todo done (and syncs back to the Feishu task). */
export function TodoCheck({ todo }: { todo: TodoItem }) {
  const { dispatch } = useStore();
  const done = todo.status === "done";
  const disabled = todo.status === "draft";
  return (
    <button
      role="checkbox"
      aria-checked={done}
      aria-label={done ? "标记为未完成" : "标记为完成"}
      disabled={disabled}
      onClick={() => dispatch({ type: "toggleDone", id: todo.id })}
      className={cn(
        "no-drag mt-[1px] grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors",
        done ? "border-primary bg-primary text-primary-foreground" : "border-input hover:border-foreground/50",
        disabled && "border-dashed opacity-60",
      )}
    >
      {done ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  );
}

export const BASIS: Record<OwnerBasis, string> = {
  "self-claimed": "自己认领",
  assigned: "会上点名",
  directory: "通讯录匹配",
  unresolved: "未识别",
};

/** One todo in a list: done check, title, where it came from, owner, due date, status. */
export function TodoRow({ todo, showMeeting = true }: { todo: TodoItem; showMeeting?: boolean }) {
  const store = useStore();
  const owner = store.person(todo.ownerPersonId);
  const meeting = store.meetings.find((m) => m.id === todo.meetingId);
  const due = dueLabel(todo.due);
  const done = todo.status === "done";

  return (
    <div className="flex items-start gap-3.5 px-5 py-3.5">
      <TodoCheck todo={todo} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[14px] leading-snug", done && "text-muted-foreground line-through decoration-subtle")}>{todo.title}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {showMeeting && meeting ? (
            <a href={href(`/meetings/${meeting.id}`)} className="truncate hover:text-foreground">
              来自「{meeting.title}」
            </a>
          ) : null}
          {todo.external ? (
            <span className="inline-flex items-center gap-1 text-clay-text">
              <ExternalLink className="size-3" aria-hidden /> 外部待办 · 由你跟进
            </span>
          ) : null}
          {todo.feishuTaskId ? (
            <span className="inline-flex items-center gap-1">
              <Send className="size-3" aria-hidden /> 已同步飞书任务
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex w-[112px] shrink-0 items-center gap-2">
        <Avatar person={owner} size={22} unknown={!owner} />
        <span className="truncate text-[13px]">{owner?.name ?? "未指定"}</span>
      </div>
      <span className={cn("num w-[84px] shrink-0 text-right text-[12.5px]", due.overdue && !done ? "text-clay-text" : "text-muted-foreground")}>
        {due.text}
      </span>
      <div className="flex w-[64px] shrink-0 justify-end">
        <TodoStatusBadge status={todo.status} />
      </div>
    </div>
  );
}

export function BasisBadge({ basis }: { basis: OwnerBasis }) {
  return <Badge tone={basis === "unresolved" ? "clay" : "outline"}>{BASIS[basis]}</Badge>;
}
