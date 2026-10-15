import { ChevronRight, Mic } from "lucide-react";
import type { Meeting } from "@echomind/shared";
import { dayLabel, duration, timeOfDay } from "@echomind/shared";
import { cn, ListenNote, MicDoodle } from "@echomind/ui";
import { MeetingStatusBadge } from "../components/ui";
import { greeting } from "../lib/dates";
import { startCapture } from "../lib/native";
import { STAGE_LABEL } from "../lib/process";
import { navigate } from "../lib/router";
import { callName, useStore } from "../lib/store";

export function MobileHome() {
  const store = useStore();
  const me = store.person(store.me);
  const drafts = (id: string) => store.todos.filter((t) => t.meetingId === id && t.status === "draft").length;

  return (
    <div className="px-5 pt-6 pb-10">
      <p className="eyebrow">EchoMind</p>
      <h1 className="serif mt-1.5 text-[28px] leading-tight">{me && me.name !== "我" ? `${greeting()}，${callName(me.name)}` : greeting()}</h1>

      <section className="card mt-5 overflow-hidden">
        <div className="flex items-center gap-4 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium">记录一场面对面的会</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">把手机放在桌上，大家说的话都会录下来。录音和转写只在这台手机上。</p>
          </div>
          <MicDoodle className="w-[64px] shrink-0" />
        </div>
        <div className="px-5 pt-4 pb-5">
          <button
            onClick={() => void startCapture()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-clay text-[15.5px] font-medium text-white active:opacity-90"
          >
            <Mic className="size-[18px]" strokeWidth={2} aria-hidden />
            开始记录
          </button>
        </div>
      </section>

      <h2 className="mt-8 mb-3 text-[13px] font-medium text-muted-foreground">会议</h2>
      {store.meetings.length ? (
        <ul className="flex flex-col gap-2.5">
          {store.meetings.map((m) => (
            <MeetingRow key={m.id} meeting={m} drafts={drafts(m.id)} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center px-6 pt-6 text-center">
          <ListenNote className="w-[130px]" />
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">还没有会议。开会时点「开始记录」，会后几分钟就有纪要和待办。</p>
        </div>
      )}
    </div>
  );
}

function MeetingRow({ meeting, drafts }: { meeting: Meeting; drafts: number }) {
  const store = useStore();
  const job = store.jobs[meeting.id];
  const working = !!job && !job.error;
  return (
    <li>
      <button onClick={() => navigate(`/meetings/${meeting.id}`)} className="card flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-secondary">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{meeting.title}</p>
          <p className="num mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span>
              {dayLabel(meeting.startedAt)} {timeOfDay(meeting.startedAt)}
            </span>
            <span>{duration(meeting.durationMs)}</span>
          </p>
          {working ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-clay transition-[width] duration-300" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
              </div>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{job.step === "models" ? "等待安装语音模型" : job.stage ? STAGE_LABEL[job.stage] : "排队中"}</span>
            </div>
          ) : null}
        </div>
        <div className={cn("flex shrink-0 flex-col items-end gap-1.5", working && "self-start")}>
          {drafts ? <span className="rounded-full bg-clay-soft px-2 py-0.5 text-[11.5px] text-clay-text">{drafts} 项待确认</span> : <MeetingStatusBadge status={meeting.status} />}
        </div>
        <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />
      </button>
    </li>
  );
}
