import { useState } from "react";
import { Clipboard } from "@echomind/ui";
import { daysBetween } from "@echomind/shared";
import { PageHeader } from "../components/Shell";
import { Segmented, Tabs } from "../components/ui";
import { TodoRow } from "../components/TodoRow";
import { LIVE, today, useStore, type TodoItem } from "../lib/store";

type Scope = "mine" | "assigned" | "external" | "all";
type When = "open" | "overdue" | "week" | "done";

export function Todos() {
  const store = useStore();
  const [scope, setScope] = useState<Scope>("mine");
  const [when, setWhen] = useState<When>("open");

  // Drafts live on the confirm page until someone sends them out.
  const live = store.todos.filter((t) => t.status !== "draft");
  const inScope = (t: TodoItem) => {
    if (scope === "mine") return t.ownerPersonId === store.me;
    if (scope === "assigned") return t.ownerPersonId !== store.me && !t.external && store.meetings.find((m) => m.id === t.meetingId)?.recorderId === store.me;
    if (scope === "external") return t.external;
    return true;
  };
  const inWhen = (t: TodoItem) => {
    const left = t.due ? daysBetween(today(), t.due) : null;
    if (when === "done") return t.status === "done";
    if (t.status === "done") return false;
    if (when === "overdue") return left !== null && left < 0;
    if (when === "week") return left !== null && left >= 0 && left < 7;
    return true;
  };

  const scoped = live.filter(inScope);
  const rows = scoped.filter(inWhen).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const drafts = store.todos.filter((t) => t.status === "draft").length;

  return (
    <div className="mx-auto max-w-[1080px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow="工作空间 · 待办"
        title="会上说的事，有人跟到底"
        lead={`会议里认领和分派的待办都在这里，${LIVE ? "确认后推送到飞书任务" : "与飞书任务双向同步"}。${drafts ? `另有 ${drafts} 项刚从会议里整理出来，确认后才会出现在这里。` : ""}`}
        art={<Clipboard />}
      />

      <Tabs
        className="mt-8"
        value={scope}
        onChange={setScope}
        options={[
          { value: "mine", label: "我负责的", count: live.filter((t) => t.ownerPersonId === store.me && t.status !== "done").length },
          { value: "assigned", label: "我分派的" },
          { value: "external", label: "外部待跟进", count: live.filter((t) => t.external && t.status !== "done").length },
          { value: "all", label: "全部" },
        ]}
      />

      <div className="mt-4 flex items-center justify-between">
        <Segmented
          value={when}
          onChange={setWhen}
          options={[
            { value: "open", label: "未完成" },
            { value: "overdue", label: "已逾期", count: scoped.filter((t) => t.status !== "done" && t.due && daysBetween(today(), t.due) < 0).length },
            { value: "week", label: "7 天内到期" },
            { value: "done", label: "已完成" },
          ]}
        />
        <span className="text-[12.5px] text-muted-foreground">{rows.length} 项</span>
      </div>

      <div className="card mt-4 divide-y divide-soft-line overflow-hidden">
        {rows.map((t) => (
          <TodoRow key={t.id} todo={t} />
        ))}
        {rows.length === 0 ? (
          <p className="px-6 py-14 text-center text-[13.5px] text-muted-foreground">
            {live.length ? "这里没有待办。换个筛选看看。" : "还没有待办。会议纪要生成后，你确认过的待办会出现在这里。"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
