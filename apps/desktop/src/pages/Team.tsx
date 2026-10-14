import { useState } from "react";
import { BellRing } from "lucide-react";
import { daysBetween } from "@echomind/shared";
import { cn, WeekCalendar } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Avatar, Badge } from "../components/ui";
import { dueLabel } from "../lib/dates";
import { today, useStore, type TodoItem } from "../lib/store";

const isOverdue = (t: TodoItem) => t.status !== "done" && !!t.due && daysBetween(today(), t.due) < 0;

export function Team() {
  const store = useStore();
  const live = store.todos.filter((t) => t.status !== "draft");
  const members = store.people
    .filter((p) => !p.external)
    .map((p) => {
      const todos = live.filter((t) => t.ownerPersonId === p.id);
      const open = todos.filter((t) => t.status !== "done").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
      return { person: p, todos, open, done: todos.length - open.length, overdue: todos.filter(isOverdue).length };
    })
    .filter((m) => m.todos.length > 0)
    .sort((a, b) => b.overdue - a.overdue || b.open.length - a.open.length);
  const [selected, setSelected] = useState(members[0]?.person.id ?? null);
  const preview = members.find((m) => m.person.id === selected) ?? members[0];

  const open = live.filter((t) => t.status !== "done");
  const doneCount = live.length - open.length;

  return (
    <div className="mx-auto max-w-[1180px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow="工作空间 · 团队"
        title="这周，大家都在推进什么"
        lead={`所有会议里分出去的待办，按人汇总。每天 ${store.settings.digestTime}，机器人会把各自的清单发到飞书，一键回复完成或延期。`}
        art={<WeekCalendar />}
      />

      <div className="mt-8 grid grid-cols-4 gap-3">
        <Stat label="进行中" value={open.length} />
        <Stat label="已完成" value={doneCount} note={live.length ? `完成率 ${Math.round((doneCount / live.length) * 100)}%` : undefined} />
        <Stat label="已逾期" value={live.filter(isOverdue).length} accent />
        <Stat label="外部待跟进" value={open.filter((t) => t.external).length} />
      </div>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_340px] gap-6">
        <div className="card overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1.1fr)_150px_56px_56px_minmax(0,1.3fr)] items-center gap-4 border-b border-border px-5 py-2.5 text-[12px] text-muted-foreground">
            <span>成员</span>
            <span>完成情况</span>
            <span>进行中</span>
            <span>逾期</span>
            <span>最近要交的</span>
          </div>
          {members.map((m) => {
            const next = m.open[0];
            const ratio = m.todos.length ? m.done / m.todos.length : 0;
            return (
              <button
                key={m.person.id}
                onClick={() => setSelected(m.person.id)}
                className={cn(
                  "no-drag grid w-full grid-cols-[minmax(0,1.1fr)_150px_56px_56px_minmax(0,1.3fr)] items-center gap-4 border-b border-soft-line px-5 py-3.5 text-left transition-colors last:border-b-0",
                  preview?.person.id === m.person.id ? "bg-background" : "hover:bg-background/60",
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar person={m.person} size={30} />
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-[14px] font-medium">{m.person.name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{m.person.title}</span>
                  </span>
                </span>
                <span className="flex items-center gap-2.5">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${ratio * 100}%` }} />
                  </span>
                  <span className="num w-9 text-right text-[12px] text-muted-foreground">
                    {m.done}/{m.todos.length}
                  </span>
                </span>
                <span className="num text-[13.5px]">{m.open.length}</span>
                <span className={cn("num text-[13.5px]", m.overdue ? "font-medium text-clay-text" : "text-subtle")}>{m.overdue || "–"}</span>
                <span className="min-w-0">
                  {next ? (
                    <>
                      <span className="block truncate text-[13px]">{next.title}</span>
                      <span className={cn("num text-[12px]", dueLabel(next.due).overdue ? "text-clay-text" : "text-muted-foreground")}>{dueLabel(next.due).text}</span>
                    </>
                  ) : (
                    <span className="text-[13px] text-subtle">都完成了</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {preview ? <DigestPreview name={preview.person.name} todos={preview.open} time={store.settings.digestTime} /> : null}
      </div>
    </div>
  );
}

function Stat({ label, value, note, accent }: { label: string; value: number; note?: string; accent?: boolean }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className={cn("serif num mt-1.5 text-[32px] leading-none", accent && value > 0 && "text-clay-text")}>{value}</p>
      {note ? <p className="mt-2 text-[12px] text-subtle">{note}</p> : <p className="mt-2 text-[12px] text-transparent">.</p>}
    </div>
  );
}

/** What this person's 9:00 Feishu card looks like. */
function DigestPreview({ name, todos, time }: { name: string; todos: TodoItem[]; time: string }) {
  return (
    <aside>
      <p className="mb-2.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <BellRing className="size-3.5" aria-hidden /> 明早 {time} {name} 会收到
      </p>
      <div className="card overflow-hidden shadow-soft">
        <div className="border-b border-border bg-secondary/70 px-4 py-3">
          <p className="text-[13.5px] font-medium">EchoMind · 今日待办</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">飞书消息卡片预览</p>
        </div>
        <div className="px-4 py-3.5">
          <p className="text-[13.5px]">
            早上好，{name.slice(1)}。你手上有 <span className="num font-medium">{todos.length}</span> 项待办：
          </p>
          <ol className="mt-3 flex flex-col gap-3">
            {todos.slice(0, 4).map((t, i) => {
              const due = dueLabel(t.due);
              return (
                <li key={t.id} className="rounded-[12px] border border-soft-line px-3 py-2.5">
                  <p className="text-[13px] leading-snug">
                    <span className="num mr-1.5 text-subtle">{i + 1}.</span>
                    {t.title}
                  </p>
                  <p className={cn("num mt-1 text-[11.5px]", due.overdue ? "text-clay-text" : "text-muted-foreground")}>截止 {due.text}</p>
                  <div className="mt-2 flex gap-1.5">
                    {["完成", "延期", "有阻碍"].map((b) => (
                      <span key={b} className="rounded-[7px] border border-border px-2.5 py-0.5 text-[12px] text-secondary-foreground">
                        {b}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
            {todos.length === 0 ? <li className="text-[13px] text-muted-foreground">今天没有待办，好好开会。</li> : null}
          </ol>
          {todos.length > 4 ? <p className="mt-2.5 text-[12px] text-muted-foreground">还有 {todos.length - 4} 项，点开查看全部</p> : null}
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-subtle">
        按钮直接更新飞书任务状态，结果回到这张表。<Badge tone="outline" className="ml-1">预览</Badge>
      </p>
    </aside>
  );
}
