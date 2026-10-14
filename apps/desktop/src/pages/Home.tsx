import { ArrowRight, ChevronRight, Sparkles } from "lucide-react";
import { dayLabel, duration, timeOfDay } from "@echomind/shared";
import { cn, ListenNote } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Button, MeetingStatusBadge, SourceTag } from "../components/ui";
import { TodoCheck } from "../components/TodoRow";
import { dueLabel, greeting, thisWeek } from "../lib/dates";
import { startCapture } from "../lib/native";
import { href, navigate } from "../lib/router";
import { callName, today, useStore } from "../lib/store";

export function Home() {
  const store = useStore();
  const me = store.person(store.me);
  const toReview = store.meetings.filter((m) => m.status === "review");
  const drafts = store.todos.filter((t) => t.status === "draft");
  const week = store.meetings.filter((m) => thisWeek(m.startedAt));
  const weekMs = week.reduce((sum, m) => sum + m.durationMs, 0);
  const tracked = store.todos.filter((t) => t.status !== "draft" && t.status !== "confirmed");
  const done = tracked.filter((t) => t.status === "done").length;
  const mine = store.todos
    .filter((t) => t.ownerPersonId === store.me && t.status !== "draft" && t.status !== "done")
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const first = toReview[0];

  return (
    <div className="mx-auto max-w-[1080px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow={`工作台 · ${dayLabel(today())}`}
        title={me && me.name !== "我" ? `${greeting()}，${callName(me.name)}` : greeting()}
        lead={
          first
            ? `「${first.title}」已经整理好，${drafts.filter((t) => t.meetingId === first.id).length} 项待办等你确认后推送到飞书。`
            : store.meetings.length
              ? "最近的会议都已整理完毕。开会时点「开始记录」，结束后几分钟就有纪要。"
              : "还没有会议记录。开会时点「开始记录」，会后在这台电脑上转写，几分钟就有纪要和待办。"
        }
        art={<ListenNote />}
      />

      {first ? (
        <div className="mt-8 flex items-center gap-4 rounded-[16px] bg-secondary px-5 py-4">
          <Sparkles className="size-[18px] shrink-0 text-clay" strokeWidth={1.8} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium">{first.title}</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              纪要已生成 · {first.minutes?.chapters.length ?? 0} 个议题 · {drafts.filter((t) => t.meetingId === first.id).length} 项待办待确认
            </p>
          </div>
          <Button variant="outline" onClick={() => navigate(`/meetings/${first.id}`)}>
            查看纪要
          </Button>
          <Button variant="primary" onClick={() => navigate(`/meetings/${first.id}/confirm`)} icon={<ArrowRight className="size-4 order-last" />}>
            确认待办
          </Button>
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-4 gap-3">
        <Stat label="本周会议" value={String(week.length)} unit="场" note={`共 ${duration(weekMs)}`} />
        <Stat label="转写时长" value={(weekMs / 3600000).toFixed(1)} unit="小时" note="麦克风 + 系统声音两路" />
        <Stat label="待办完成率" value={tracked.length ? String(Math.round((done / tracked.length) * 100)) : "–"} unit="%" note={`${done} / ${tracked.length} 项已完成`} />
        <Stat label="等你确认" value={String(drafts.length)} unit="项" note="确认后才会推送到飞书" accent />
      </div>

      <div className="mt-8 grid grid-cols-[1.35fr_1fr] gap-6">
        <section>
          <SectionTitle title="最近会议" to="/meetings" more="全部会议" />
          <div className="card divide-y divide-soft-line overflow-hidden">
            {store.meetings.length === 0 ? (
              <div className="flex flex-col items-center px-5 py-8 text-center">
                <p className="text-[13px] text-muted-foreground">录下的会议会出现在这里。</p>
                <Button variant="primary" size="sm" className="mt-3" onClick={() => void startCapture()}>
                  开始记录
                </Button>
              </div>
            ) : null}
            {store.meetings.slice(0, 5).map((m) => (
              <a key={m.id} href={href(`/meetings/${m.id}`)} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-background/70">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{m.title}</p>
                  <p className="mt-1 flex items-center gap-3 text-[12.5px] text-muted-foreground">
                    <SourceTag source={m.source} />
                    <span className="num">
                      {dayLabel(m.startedAt)} {timeOfDay(m.startedAt)}
                    </span>
                    <span>{duration(m.durationMs)}</span>
                  </p>
                </div>
                <MeetingStatusBadge status={m.status} />
                <ChevronRight className="size-4 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
              </a>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle title="我的待办" to="/todos" more="待办中心" />
          <div className="card divide-y divide-soft-line overflow-hidden">
            {mine.length === 0 ? <p className="px-5 py-8 text-center text-[13px] text-muted-foreground">手上没有进行中的待办。</p> : null}
            {mine.slice(0, 5).map((t) => {
              const due = dueLabel(t.due);
              const meeting = store.meetings.find((m) => m.id === t.meetingId);
              return (
                <div key={t.id} className="flex items-start gap-3 px-5 py-3.5">
                  <TodoCheck todo={t} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] leading-snug">{t.title}</p>
                    <p className="mt-1 truncate text-[12px] text-muted-foreground">{meeting?.title}</p>
                  </div>
                  <span className={cn("num shrink-0 text-[12px]", due.overdue ? "text-clay-text" : "text-muted-foreground")}>{due.text}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, unit, note, accent }: { label: string; value: string; unit: string; note: string; accent?: boolean }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1">
        <span className={cn("serif num text-[32px] leading-none", accent && "text-clay-text")}>{value}</span>
        <span className="text-[13px] text-muted-foreground">{unit}</span>
      </p>
      <p className="mt-2 text-[12px] text-subtle">{note}</p>
    </div>
  );
}

export function SectionTitle({ title, to, more }: { title: string; to?: string; more?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="serif text-[20px]">{title}</h2>
      {to && more ? (
        <a href={href(to)} className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
          {more} <ArrowRight className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}
