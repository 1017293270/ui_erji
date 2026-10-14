import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { MeetingStatus } from "@echomind/shared";
import { dayLabel, duration, timeOfDay } from "@echomind/shared";
import { PluckSlip, SearchArt } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Avatar, MeetingStatusBadge, Segmented, SourceTag } from "../components/ui";
import { href } from "../lib/router";
import { useStore } from "../lib/store";

type Filter = "all" | "review" | "pushed" | "progress" | "failed";

const MATCH: Record<Filter, (s: MeetingStatus) => boolean> = {
  all: () => true,
  review: (s) => s === "review",
  pushed: (s) => s === "pushed" || s === "ready",
  progress: (s) => s === "transcribing" || s === "recording",
  failed: (s) => s === "failed",
};

export function Meetings() {
  const store = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => store.meetings.filter((m) => MATCH[filter](m.status) && (!query || m.title.includes(query.trim()))),
    [store.meetings, filter, query],
  );
  const count = (f: Filter) => store.meetings.filter((m) => MATCH[f](m.status)).length;

  return (
    <div className="mx-auto max-w-[1080px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow="工作空间 · 会议"
        title="每一场会，都有据可查"
        lead="录下来的会议在这里转写、分议题、写纪要。点开任意一场，每条结论都能追溯到原话。"
        art={<PluckSlip />}
      />

      <div className="mt-8 flex items-center gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部", count: count("all") },
            { value: "review", label: "待确认", count: count("review") },
            { value: "pushed", label: "已完成", count: count("pushed") },
            { value: "progress", label: "处理中", count: count("progress") },
            { value: "failed", label: "失败", count: count("failed") },
          ]}
        />
        <div className="flex-1" />
        <label className="flex h-9 w-[260px] items-center gap-2 rounded-[10px] border border-border bg-card px-3 focus-within:border-ring">
          <Search className="size-4 text-subtle" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按会议名搜索"
            className="h-full flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-subtle"
          />
        </label>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_96px_124px_84px_72px_92px_20px] items-center gap-4 border-b border-border px-5 py-2.5 text-[12px] text-muted-foreground">
          <span>会议</span>
          <span>来源</span>
          <span>时间</span>
          <span>时长</span>
          <span>待办</span>
          <span>状态</span>
          <span />
        </div>
        {rows.map((m) => {
          const todos = store.todos.filter((t) => t.meetingId === m.id);
          return (
            <a
              key={m.id}
              href={href(`/meetings/${m.id}`)}
              className="group grid grid-cols-[minmax(0,1fr)_96px_124px_84px_72px_92px_20px] items-center gap-4 border-b border-soft-line px-5 py-3.5 transition-colors last:border-b-0 hover:bg-background/70"
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{m.title}</span>
                <span className="mt-1.5 flex items-center">
                  {m.participantIds.slice(0, 5).map((id, i) => (
                    <Avatar key={id} person={store.person(id)} size={20} className={i > 0 ? "-ml-1.5 ring-2 ring-card" : "ring-2 ring-card"} />
                  ))}
                  <span className="ml-2 text-[12px] text-muted-foreground">{m.participantIds.length} 人</span>
                </span>
              </span>
              <SourceTag source={m.source} />
              <span className="num text-[13px] text-muted-foreground">
                {dayLabel(m.startedAt)} {timeOfDay(m.startedAt)}
              </span>
              <span className="text-[13px] text-muted-foreground">{duration(m.durationMs)}</span>
              <span className="num text-[13px] text-muted-foreground">{todos.length ? `${todos.length} 项` : "–"}</span>
              <span>
                <MeetingStatusBadge status={m.status} />
              </span>
              <ChevronRight className="size-4 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
            </a>
          );
        })}
        {rows.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <SearchArt className="w-[90px]" />
            {store.meetings.length ? (
              <>
                <p className="serif mt-4 text-[20px]">没有找到相关会议</p>
                <p className="mt-1.5 text-[13px] text-muted-foreground">换个关键词，或者切回「全部」看看。</p>
              </>
            ) : (
              <>
                <p className="serif mt-4 text-[20px]">还没有会议记录</p>
                <p className="mt-1.5 text-[13px] text-muted-foreground">开会时点左下角的「开始记录」。会后在这台电脑上转写，几分钟就有纪要和待办。</p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
