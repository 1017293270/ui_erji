import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Mic, RefreshCw } from "lucide-react";
import type { Minutes, Point, Speaker } from "@echomind/shared";
import { clock, dayLabel, timeOfDay } from "@echomind/shared";
import { cn } from "@echomind/ui";
import { Avatar, Badge, Button, SpeakerDot, Tabs } from "../../components/ui";
import { BasisBadge } from "../../components/TodoRow";
import { dueLabel } from "../../lib/dates";
import { navigate } from "../../lib/router";
import { LIVE, speakerName, speakerTone, useStore } from "../../lib/store";
import { useDetail } from "./context";

export type SideTab = "minutes" | "todos" | "speakers";

export function SidePanel({ tab, onTab, naming, onNaming }: { tab: SideTab; onTab: (t: SideTab) => void; naming: string | null; onNaming: (id: string | null) => void }) {
  const store = useStore();
  const { meeting, speakers } = useDetail();
  const todos = store.todos.filter((t) => t.meetingId === meeting.id);
  const unnamed = [...speakers.values()].filter((s) => !s.personId).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        className="px-6"
        value={tab}
        onChange={onTab}
        options={[
          { value: "minutes", label: "纪要" },
          { value: "todos", label: "待办", count: todos.length },
          { value: "speakers", label: "说话人", count: unnamed ? undefined : speakers.size },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-10">
        {tab === "minutes" && meeting.minutes ? <MinutesTab minutes={meeting.minutes} /> : null}
        {tab === "todos" ? <TodosTab /> : null}
        {tab === "speakers" ? <SpeakersTab naming={naming} onNaming={onNaming} /> : null}
      </div>
    </div>
  );
}

/** A small chip that jumps to the line a statement came from. */
export function Cite({ ids }: { ids: string[] }) {
  const { segments, jump } = useDetail();
  const first = segments.find((s) => s.id === ids[0]);
  if (!first) return null;
  return (
    <button
      onClick={() => jump(first.id)}
      title="跳到原话"
      aria-label={`跳到原话 ${clock(first.start)}`}
      className="no-drag num ml-1.5 inline-flex h-[19px] translate-y-[-1px] items-center gap-1 rounded-full border border-border px-1.5 align-middle text-[11px] text-muted-foreground transition-colors hover:border-clay hover:text-clay-text"
    >
      {clock(first.start)}
      {ids.length > 1 ? <span className="text-subtle">+{ids.length - 1}</span> : null}
    </button>
  );
}

function PointList({ title, points, marker }: { title: string; points: Point[]; marker: "dot" | "check" | "q" }) {
  if (!points.length) return null;
  return (
    <section className="mt-6">
      <h3 className="mb-2.5 text-[12.5px] font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-2.5">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px] leading-[1.7]">
            <span className="mt-[9px] shrink-0">
              {marker === "check" ? (
                <Check className="-mt-[3px] size-3.5 text-clay" strokeWidth={2.4} aria-hidden />
              ) : marker === "q" ? (
                <span className="block size-1.5 rounded-full border border-clay" />
              ) : (
                <span className="block size-1.5 rounded-full bg-foreground/60" />
              )}
            </span>
            <p className="selectable">
              {p.text}
              <Cite ids={p.evidence} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MinutesTab({ minutes }: { minutes: Minutes }) {
  const store = useStore();
  const { meeting } = useDetail();
  const busy = !!store.jobs[meeting.id];
  const g = minutes.generation;
  return (
    <div className="fade-in">
      <p className="selectable text-[14px] leading-[1.8] text-foreground/90">{minutes.overview}</p>
      <PointList title="决定" points={minutes.decisions} marker="check" />
      <PointList title="结论" points={minutes.conclusions} marker="dot" />
      <PointList title="待解决" points={minutes.openQuestions} marker="q" />
      <div className="mt-8 flex items-center gap-3 border-t border-soft-line pt-4 text-[12px] text-subtle">
        <span className="flex-1">
          由 DeepSeek（{g.model}）生成 · {dayLabel(g.generatedAt)} {timeOfDay(g.generatedAt)} · 每条都附原话出处
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          icon={<RefreshCw className={cn("size-3.5", busy && "animate-spin")} />}
          onClick={() => (LIVE ? store.process(meeting.id) : store.toast("示例会议不能重新生成。"))}
        >
          {busy ? "正在生成…" : "重新生成"}
        </Button>
      </div>
    </div>
  );
}

function TodosTab() {
  const store = useStore();
  const { meeting, jump } = useDetail();
  const todos = store.todos.filter((t) => t.meetingId === meeting.id);
  const drafts = todos.filter((t) => t.status === "draft");

  return (
    <div className="fade-in">
      {drafts.length ? (
        <div className="mb-4 flex items-center gap-3 rounded-[14px] bg-secondary px-4 py-3">
          <p className="flex-1 text-[13px] leading-snug">
            {drafts.length} 项待办还没确认，确认负责人和截止时间后再推到飞书。
          </p>
          <Button variant="primary" size="sm" onClick={() => navigate(`/meetings/${meeting.id}/confirm`)}>
            去确认
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {todos.map((t) => {
          const owner = store.person(t.ownerPersonId);
          const due = dueLabel(t.due);
          return (
            <li key={t.id} className="rounded-[14px] border border-border bg-card px-4 py-3">
              <p className="text-[13.5px] leading-snug font-medium">{t.title}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <Avatar person={owner} size={20} unknown={!owner} />
                <span className="text-foreground">{owner?.name ?? "未指定"}</span>
                <BasisBadge basis={t.ownerBasis} />
                {t.external ? <Badge tone="clay">外部</Badge> : null}
                <span className="flex-1" />
                <span className={cn("num", due.overdue && "text-clay-text")}>{t.dueText ?? due.text}</span>
                <button onClick={() => t.evidence[0] && jump(t.evidence[0])} className="no-drag hover:text-clay-text">
                  原话
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SpeakersTab({ naming, onNaming }: { naming: string | null; onNaming: (id: string | null) => void }) {
  const store = useStore();
  const { meeting, segments, speakers } = useDetail();
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0) || 1;

  return (
    <div className="fade-in flex flex-col gap-2.5">
      <p className="mb-1 text-[12.5px] leading-relaxed text-muted-foreground">
        麦克风那一路是你本人；系统声音那一路按声音区分成不同的人。改了名字，整场逐字稿和待办都会跟着更新。
      </p>
      {[...speakers.values()].map((s) => {
        const share = segments.filter((x) => x.speakerId === s.id).reduce((sum, x) => sum + (x.end - x.start), 0) / total;
        const lines = segments.filter((x) => x.speakerId === s.id).length;
        const person = store.person(s.personId);
        const open = naming === s.id;
        return (
          <div key={s.id} className={cn("rounded-[14px] border bg-card px-4 py-3 transition-shadow", open ? "border-input shadow-pop" : "border-border")}>
            <div className="flex items-center gap-3">
              <Avatar person={person} size={32} unknown={!person} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[14px] font-medium">
                  <SpeakerDot tone={speakerTone(s.id)} />
                  {speakerName(store, s)}
                  {person ? <span className="text-[12px] font-normal text-subtle">{s.label}</span> : null}
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {sourceText(s)} · {lines} 句 · 发言 {Math.round(share * 100)}%
                </p>
              </div>
              {s.source !== "self" && !open ? (
                <Button variant={person ? "ghost" : "subtle"} size="sm" onClick={() => onNaming(s.id)}>
                  {person ? "更改" : "命名"}
                </Button>
              ) : null}
            </div>
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: `var(--sp-${speakerTone(s.id)})` }} />
            </div>
            {open ? <NameSpeaker speaker={s} meetingId={meeting.id} participantIds={meeting.participantIds} onDone={() => onNaming(null)} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function sourceText(s: Speaker) {
  switch (s.source) {
    case "self":
      return "本人 · 麦克风";
    case "voiceprint":
      return `声纹识别 ${Math.round((s.confidence ?? 0) * 100)}%`;
    case "manual":
      return "手动命名";
    default:
      return "未识别 · 系统声音";
  }
}

/** Naming a voice: this meeting's participants first, then everyone else. */
function NameSpeaker({ speaker, meetingId, participantIds, onDone }: { speaker: Speaker; meetingId: string; participantIds: string[]; onDone: () => void }) {
  const store = useStore();
  const [picked, setPicked] = useState<string | null>(speaker.personId);
  const [remember, setRemember] = useState(true);
  const named = new Set(
    (store.meetings.find((m) => m.id === meetingId)?.transcript?.speakers ?? []).filter((s) => s.id !== speaker.id).map((s) => s.personId),
  );
  const participants = store.people.filter((p) => participantIds.includes(p.id));
  const others = store.people.filter((p) => !participantIds.includes(p.id));
  const pickedPerson = store.person(picked);
  const enrolled = picked ? store.voiceprints[picked]?.status === "enrolled" : false;
  const panel = useRef<HTMLDivElement>(null);

  // Opened from the transcript, the panel may sit below the fold of the side column.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const option = (id: string) => {
    const p = store.person(id)!;
    const taken = named.has(id);
    return (
      <button
        key={id}
        onClick={() => setPicked(id)}
        className={cn(
          "no-drag flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-left text-[13px] transition-colors",
          picked === id ? "border-foreground bg-background" : "border-border hover:border-input",
        )}
      >
        <Avatar person={p} size={20} />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {taken ? <span className="text-[11px] text-subtle">已对应</span> : null}
      </button>
    );
  };

  return (
    <div ref={panel} className="fade-in mt-3.5 border-t border-soft-line pt-3.5">
      <p className="mb-2 text-[12px] text-muted-foreground">这场会的参会人</p>
      <div className="grid grid-cols-2 gap-1.5">{participants.map((p) => option(p.id))}</div>
      <p className="mt-3 mb-2 text-[12px] text-muted-foreground">其他人</p>
      <div className="grid grid-cols-2 gap-1.5">{others.map((p) => option(p.id))}</div>
      {pickedPerson && !pickedPerson.external && !enrolled ? (
        <label className="mt-3.5 flex cursor-pointer items-start gap-2.5 rounded-[10px] bg-secondary px-3 py-2.5">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-[3px] accent-[var(--primary)]" />
          <span className="text-[12.5px] leading-relaxed">
            记住 {pickedPerson.name} 的声音
            <span className="block text-muted-foreground">会给 {pickedPerson.name} 发一张飞书卡片，本人点同意后才保存声纹。</span>
          </span>
        </label>
      ) : null}
      <div className="mt-3.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!picked}
          icon={<Mic className="size-3.5" />}
          onClick={() => {
            store.dispatch({ type: "renameSpeaker", meetingId, speakerId: speaker.id, personId: picked, remember: remember && !enrolled });
            onDone();
          }}
        >
          保存
        </Button>
      </div>
    </div>
  );
}

export function GoConfirm({ meetingId, count }: { meetingId: string; count: number }) {
  return (
    <Button variant="primary" onClick={() => navigate(`/meetings/${meetingId}/confirm`)} icon={<ArrowRight className="order-last size-4" />}>
      确认待办 · {count}
    </Button>
  );
}
