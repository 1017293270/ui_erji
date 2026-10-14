import { useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronDown, ExternalLink, Quote, Send, Trash2 } from "lucide-react";
import { clock, dayLabel, daysBetween } from "@echomind/shared";
import { cn, Handoff } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Avatar, Badge, Button, IconButton } from "../components/ui";
import { BASIS } from "../components/TodoRow";
import { href, navigate } from "../lib/router";
import { useFeishuLogin } from "../components/Feishu";
import { pushToFeishu } from "../lib/push";
import { LIVE, speakerName, today, useStore, type TodoItem } from "../lib/store";
import { Centered } from "./MeetingDetail";

/**
 * After the meeting, the recorder goes over each todo once: who owns it, by
 * when, and whether it should go out at all. Nothing reaches Feishu before this.
 */
const TASK_SCOPE = "task:task:write";

export function ConfirmTodos({ id }: { id: string }) {
  const store = useStore();
  const meeting = store.meetings.find((m) => m.id === id);
  const drafts = store.todos.filter((t) => t.meetingId === id && t.status === "draft");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const feishu = useFeishuLogin();

  if (!meeting) return null;

  if (!drafts.length) {
    return (
      <Centered art={<Handoff className="w-[200px]" />} title="待办都已交到对的人手上" text="这场会的待办已经推送到飞书任务。负责人每天早上会收到提醒，完成情况会回到这里。">
        <div className="flex gap-2">
          <Button onClick={() => navigate(`/meetings/${id}`)}>回到纪要</Button>
          <Button variant="primary" onClick={() => navigate("/todos")}>
            查看待办中心
          </Button>
        </div>
      </Centered>
    );
  }

  const chosen = drafts.filter((t) => !skipped.has(t.id));
  // Outside owners need no account: their todos become reminders for the recorder.
  const missingOwner = chosen.filter((t) => !t.ownerPersonId && !t.external);
  const external = chosen.filter((t) => t.external);
  const internal = chosen.length - external.length;
  const signIn = !LIVE ? null : !store.feishu?.user ? "推送前先登录飞书" : store.feishu.missingScopes?.includes(TASK_SCOPE) ? "飞书登录还没有任务权限，重新登录一次即可" : null;

  const push = async () => {
    skipped.forEach((tid) => store.dispatch({ type: "discardTodo", id: tid }));
    if (!LIVE) {
      store.dispatch({ type: "pushTodos", meetingId: id, ids: chosen.map((t) => t.id) });
      store.toast(`已推送 ${internal} 项到飞书任务${external.length ? `，${external.length} 项外部待办会提醒你跟进` : ""}。（演示：尚未连接真实飞书）`, "success");
      return;
    }
    setPushing(true);
    const { taskIds, error } = await pushToFeishu(chosen, meeting, store.me, (pid) => store.person(pid)?.name);
    setPushing(false);
    const ids = Object.keys(taskIds);
    if (ids.length) store.dispatch({ type: "pushTodos", meetingId: id, ids, taskIds });
    if (error) store.toast(`${ids.length ? `已推送 ${ids.length} 项，` : ""}${chosen.length - ids.length} 项没有推送成功：${error}`, "error");
    else store.toast(`已推送 ${internal} 项到飞书任务${external.length ? `，${external.length} 项外部待办已作为提醒发给你` : ""}。`, "success");
  };

  return (
    <div className="mx-auto max-w-[960px] px-10 pt-7 pb-32">
      <a href={href(`/meetings/${id}`)} className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> {meeting.title}
      </a>
      <div className="mt-3">
        <PageHeader
          eyebrow="确认待办 · 推送前的最后一步"
          title="把待办交到对的人手上"
          lead="AI 从会议里找出了这些待办。核对负责人和截止时间，拿不准的已经标出来了；确认后推送到飞书任务。"
          art={<Handoff />}
        />
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {drafts.map((t, i) => (
          <DraftCard
            key={t.id}
            todo={t}
            index={i + 1}
            skipped={skipped.has(t.id)}
            participantIds={meeting.participantIds}
            onSkip={(skip) =>
              setSkipped((s) => {
                const next = new Set(s);
                if (skip) next.add(t.id);
                else next.delete(t.id);
                return next;
              })
            }
          />
        ))}
      </div>

      <div className="fixed right-0 bottom-0 left-[232px] border-t border-border bg-background/92 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[960px] items-center gap-4 px-10 py-3.5">
          <p className="flex-1 text-[13px] text-muted-foreground">
            将推送 <span className="num font-medium text-foreground">{internal}</span> 项到飞书任务
            {external.length ? (
              <>
                ，<span className="num font-medium text-foreground">{external.length}</span> 项外部待办提醒你本人跟进
              </>
            ) : null}
            {skipped.size ? <>，跳过 {skipped.size} 项</> : null}
            {missingOwner.length ? <span className="text-clay-text">。还有 {missingOwner.length} 项没有负责人</span> : null}
            {signIn ? <span className="block text-clay-text">{feishu.error ?? signIn}</span> : null}
          </p>
          {signIn ? (
            <Button variant="outline" disabled={feishu.busy} onClick={() => void feishu.login()}>
              {feishu.busy ? "等待授权…" : "登录飞书"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate(`/meetings/${id}`)}>
            稍后再说
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!chosen.length || missingOwner.length > 0 || !!signIn || pushing}
            onClick={() => void push()}
            icon={<Send className="size-4" />}
          >
            {pushing ? "正在推送…" : "确认并推送"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftCard({
  todo,
  index,
  skipped,
  participantIds,
  onSkip,
}: {
  todo: TodoItem;
  index: number;
  skipped: boolean;
  participantIds: string[];
  onSkip: (skip: boolean) => void;
}) {
  const store = useStore();
  const meeting = store.meetings.find((m) => m.id === todo.meetingId);
  const owner = store.person(todo.ownerPersonId);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const lowConfidence = todo.ownerBasis === "unresolved" || todo.ownerConfidence < 0.6;
  const evidence = useMemo(
    () => (meeting?.transcript?.segments ?? []).filter((s) => todo.evidence.includes(s.id)),
    [meeting, todo.evidence],
  );
  const speakers = new Map((meeting?.transcript?.speakers ?? []).map((s) => [s.id, s]));
  const people = [...store.people].sort((a, b) => Number(participantIds.includes(b.id)) - Number(participantIds.includes(a.id)));

  return (
    <article className={cn("card px-5 py-4", skipped && "bg-transparent")}>
      <div className="flex items-start gap-4">
        <span className="serif num mt-0.5 w-5 shrink-0 text-[17px] text-subtle">{index}</span>
        {/* Only the content fades when skipped; the restore button stays readable. */}
        <div className={cn("min-w-0 flex-1 transition-opacity", skipped && "opacity-45")}>
          <input
            value={todo.title}
            onChange={(e) => store.dispatch({ type: "updateTodo", id: todo.id, patch: { title: e.target.value } })}
            disabled={skipped}
            aria-label="待办内容"
            className="w-full rounded-[8px] bg-transparent px-1.5 py-0.5 -mx-1.5 text-[15px] font-medium outline-none hover:bg-background focus:bg-background"
          />
          {todo.detail ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{todo.detail}</p> : null}

          <div className="mt-3.5 grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3">
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                负责人
                <span className="text-subtle">
                  {BASIS[todo.ownerBasis]}
                  {todo.ownerMention && todo.ownerMention !== "我" ? `「${todo.ownerMention}」` : ""}
                </span>
                {lowConfidence ? <Badge tone="clay">需要你确认</Badge> : null}
              </span>
              <span className={cn("relative flex h-10 items-center gap-2 rounded-[10px] border bg-card px-2.5", lowConfidence ? "border-clay/60" : "border-border")}>
                <Avatar person={owner} size={22} unknown={!owner} />
                <select
                  value={todo.ownerPersonId ?? ""}
                  disabled={skipped}
                  onChange={(e) => {
                    const p = store.person(e.target.value);
                    store.dispatch({
                      type: "updateTodo",
                      id: todo.id,
                      patch: { ownerPersonId: p?.id ?? null, external: !!p?.external, ownerBasis: p ? "assigned" : "unresolved", ownerConfidence: p ? 1 : 0 },
                    });
                  }}
                  className="h-full flex-1 appearance-none bg-transparent pr-6 text-[13.5px] outline-none"
                >
                  <option value="">选择负责人…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.external ? `（外部 · ${p.company ?? ""}）` : participantIds.includes(p.id) ? "（参会）" : `（${p.department ?? ""}）`}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-subtle" aria-hidden />
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                截止时间{todo.dueText ? <span className="text-subtle">会上说「{todo.dueText}」</span> : null}
              </span>
              <DueField
                value={todo.due}
                disabled={skipped}
                onChange={(due) => store.dispatch({ type: "updateTodo", id: todo.id, patch: { due } })}
              />
            </label>
          </div>

          {todo.external ? (
            <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-clay-text">
              <ExternalLink className="size-3.5" aria-hidden /> {owner?.name ?? todo.ownerMention ?? "对方"}不在公司通讯录里，这项会作为提醒发给你本人跟进。
            </p>
          ) : null}

          <button onClick={() => setQuoteOpen((o) => !o)} className="no-drag mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
            <Quote className="size-3.5" aria-hidden /> {quoteOpen ? "收起原话" : `原话 · ${evidence.length} 句`}
          </button>
          {quoteOpen ? (
            <div className="fade-in mt-2 flex flex-col gap-1.5 rounded-[12px] bg-secondary px-4 py-3">
              {evidence.map((s) => (
                <a key={s.id} href={href(`/meetings/${todo.meetingId}?seg=${s.id}`)} className="group flex gap-3 text-[13px] leading-relaxed">
                  <span className="num w-9 shrink-0 text-[11.5px] leading-[22px] text-subtle group-hover:text-clay-text">{clock(s.start)}</span>
                  <span>
                    <span className="font-medium">{speakerName(store, speakers.get(s.speakerId))}：</span>
                    {s.text}
                  </span>
                </a>
              ))}
            </div>
          ) : null}
        </div>
        {skipped ? (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onSkip(false)}>
            恢复
          </Button>
        ) : (
          <IconButton label="不推送这项" onClick={() => onSkip(true)}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
    </article>
  );
}

/**
 * The due date, written the way the rest of the app writes dates (10-21 周三 · 8 天后)
 * rather than in the system locale; the native picker still does the choosing.
 */
function DueField({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (due: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const n = value ? daysBetween(today(), value) : 0;
  const relative = !value ? "" : n === 0 ? "今天" : n === 1 ? "明天" : n > 0 ? `${n} 天后` : `已过 ${-n} 天`;
  return (
    <span className="relative flex h-10 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-[13.5px] focus-within:border-ring">
      <CalendarDays className="size-4 text-subtle" aria-hidden />
      {value ? (
        <span className="num">
          {dayLabel(value)}
          <span className={cn("ml-2 text-[12px]", n < 0 ? "text-destructive" : "text-muted-foreground")}>{relative}</span>
        </span>
      ) : (
        <span className="text-subtle">选择日期…</span>
      )}
      <input
        ref={input}
        type="date"
        aria-label="截止时间"
        value={value ?? ""}
        disabled={disabled}
        onClick={() => {
          try {
            input.current?.showPicker();
          } catch {
            // Older webviews open the picker on their own.
          }
        }}
        onChange={(e) => onChange(e.target.value || null)}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
      />
    </span>
  );
}
