import { useState } from "react";
import { ArrowLeft, Check, Download, RefreshCw, Share2 } from "lucide-react";
import type { Meeting } from "@echomind/shared";
import { dayLabel, duration, timeOfDay } from "@echomind/shared";
import { Clipboard, cn, InboxTray, SearchArt } from "@echomind/ui";
import { Avatar, Button, MeetingStatusBadge, SourceTag } from "../components/ui";
import { href, navigate, useLocation } from "../lib/router";
import { revealRecordings } from "../lib/native";
import { isMobile } from "../lib/platform";
import { formatBytes, STAGE_LABEL, type Job } from "../lib/process";
import { LIVE, useStore } from "../lib/store";
import { DetailProvider } from "./meeting/context";
import { ChapterRail, TranscriptView } from "./meeting/Transcript";
import { GoConfirm, SidePanel, type SideTab } from "./meeting/Side";

export function MeetingDetail({ id }: { id: string }) {
  const store = useStore();
  const { query } = useLocation();
  const meeting = store.meetings.find((m) => m.id === id);
  const [tab, setTab] = useState<SideTab>("minutes");
  const [naming, setNaming] = useState<string | null>(null);

  if (!meeting) {
    return (
      <Centered art={<SearchArt className="w-[90px]" />} title="找不到这场会议" text="它可能已被删除。">
        <Button onClick={() => navigate("/meetings")}>回到会议列表</Button>
      </Centered>
    );
  }

  const drafts = store.todos.filter((t) => t.meetingId === id && t.status === "draft").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-end gap-6 border-b border-border px-8 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <a href={href("/meetings")} className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> 全部会议
          </a>
          <h1 className="serif mt-2 truncate text-[27px] leading-tight">{meeting.title}</h1>
          <div className="mt-2 flex items-center gap-4 text-[12.5px] text-muted-foreground">
            <SourceTag source={meeting.source} />
            <span className="num">
              {dayLabel(meeting.startedAt)} {timeOfDay(meeting.startedAt)}
            </span>
            <span>{duration(meeting.durationMs)}</span>
            <span className="flex items-center">
              {meeting.participantIds.map((pid, i) => (
                <Avatar key={pid} person={store.person(pid)} size={20} className={i > 0 ? "-ml-1.5 ring-2 ring-background" : "ring-2 ring-background"} />
              ))}
              <span className="ml-2">{meeting.participantIds.length} 人</span>
            </span>
            <MeetingStatusBadge status={meeting.status} />
          </div>
        </div>
        {meeting.transcript ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" icon={<Download className="size-4" />} onClick={() => store.toast("导出 Word / Markdown 将在下一版提供。")}>
              导出
            </Button>
            <Button variant="outline" icon={<Share2 className="size-4" />} onClick={() => store.toast("纪要会以卡片形式发到飞书群（接入飞书后可用）。")}>
              发到飞书群
            </Button>
            {drafts ? <GoConfirm meetingId={meeting.id} count={drafts} /> : null}
          </div>
        ) : null}
      </header>

      {meeting.transcript && meeting.minutes ? (
        <DetailProvider meeting={meeting} initialSegment={query.get("seg")}>
          <div className="flex min-h-0 flex-1">
            <aside className="w-[232px] shrink-0 overflow-y-auto border-r border-border bg-sidebar/40">
              <ChapterRail chapters={meeting.minutes.chapters} />
            </aside>
            <TranscriptView
              chapters={meeting.minutes.chapters}
              onNameSpeaker={(sid) => {
                setTab("speakers");
                setNaming(sid);
              }}
            />
            <aside className="flex w-[384px] shrink-0 flex-col border-l border-border">
              <SidePanel tab={tab} onTab={setTab} naming={naming} onNaming={setNaming} />
            </aside>
          </div>
        </DetailProvider>
      ) : (
        <NoTranscript meeting={meeting} />
      )}
    </div>
  );
}

function NoTranscript({ meeting }: { meeting: Meeting }) {
  if (LIVE) return <Processing meeting={meeting} />;
  if (meeting.status === "transcribing" || meeting.status === "recording") {
    return (
      <Centered art={<InboxTray className="w-[180px]" />} title="正在转写和整理" text="录音已经分段上传。转写、区分说话人、生成纪要和待办，通常在会后几分钟内完成。">
        <ol className="mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          {["上传录音", "转写", "区分说话人", "纪要与待办"].map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 ? <span className="h-px w-5 bg-border" /> : null}
              <span className={i === 0 ? "text-foreground" : undefined}>
                <span className="num mr-1.5 inline-grid size-5 place-items-center rounded-full bg-secondary text-[11px]">{i + 1}</span>
                {s}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[12px] text-subtle">演示版尚未接入转写服务，这一步会停在这里。</p>
      </Centered>
    );
  }
  if (meeting.status === "failed") {
    return (
      <Centered art={<SearchArt className="w-[90px]" />} title="这场会议没有录到其他人的声音" text="系统声音这一路是空的，通常是「系统录音」权限没有打开。你的麦克风录音已保留。">
        <Button variant="primary" onClick={() => navigate("/settings")}>
          检查录音权限
        </Button>
      </Centered>
    );
  }
  return (
    <Centered art={<Clipboard className="w-[170px]" />} title="纪要已推送到飞书" text="这是一条示例记录，只保留了概要。打开「EchoMind 桌面端二期需求评审」可以看到完整的逐字稿、纪要和待办。">
      <Button variant="primary" onClick={() => navigate("/meetings/m-1012-review")}>
        打开完整示例
      </Button>
    </Centered>
  );
}

const STEPS = ["找出说话的片段", "区分说话人", "转成文字", "纪要与待办"];

function stepOf(job: Job | undefined): number {
  if (!job || job.step !== "transcribe") return job?.step === "minutes" ? 3 : 0;
  return job.stage === "speakers" ? 1 : job.stage === "text" ? 2 : 0;
}

/** A recorded meeting on its way to minutes: transcribed here, summarized by DeepSeek. */
export function Processing({ meeting }: { meeting: Meeting }) {
  const store = useStore();
  const job = store.jobs[meeting.id];

  if (job?.error || (meeting.status === "failed" && !job)) {
    const title = !job ? "上次没有整理完" : job.step === "minutes" ? "纪要没有生成" : "转写没有完成";
    const text = job?.error ?? "整理到一半应用退出了，或者出了错。录音还在，可以重新整理。";
    return (
      <Centered art={<SearchArt className="w-[90px]" />} title={title} text={text}>
        <div className="flex gap-2">
          {isMobile ? null : <Button onClick={() => void revealRecordings()}>打开录音文件夹</Button>}
          <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => store.process(meeting.id)}>
            重试
          </Button>
        </div>
      </Centered>
    );
  }

  if (job?.step === "models") {
    const download = store.download;
    const size = store.models?.downloadBytes ?? 0;
    return (
      <Centered
        art={<InboxTray className="w-[180px]" />}
        title={isMobile ? "先安装语音识别模型" : "先下载语音识别模型"}
        text={
          isMobile
            ? "转写全部在这台手机上完成，录音不会上传。第一次使用要把安装包里的模型解压出来，只需要一次。"
            : `转写全部在这台电脑上完成，录音不会上传。第一次使用需要下载${size ? `约 ${formatBytes(size)} ` : ""}的模型，之后不用再下。`
        }
      >
        {download ? (
          <div className="w-full max-w-[320px]">
            <Bar value={download.total ? download.received / download.total : 0} />
            <p className="num mt-2 text-[12px] text-muted-foreground">
              {formatBytes(download.received)}
              {download.total ? ` / ${formatBytes(download.total)}` : ""}
            </p>
          </div>
        ) : (
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void store.downloadModels()}>
            {isMobile ? "安装模型" : "下载模型"}
          </Button>
        )}
      </Centered>
    );
  }

  const current = stepOf(job);
  return (
    <Centered art={<InboxTray className="w-[180px]" />} title="正在整理这场会议" text={`转写在这台${isMobile ? "手机" : "电脑"}上完成，录音不离开本机；DeepSeek 只读文字稿，写出纪要和待办。`}>
      <ol className="mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 ? <span className="h-px w-5 bg-border" /> : null}
            <span className={cn("whitespace-nowrap", i <= current && "text-foreground")}>
              <span className={cn("num mr-1.5 inline-grid size-5 place-items-center rounded-full text-[11px]", i < current ? "bg-clay-soft text-clay-text" : "bg-secondary")}>
                {i < current ? <Check className="size-3" strokeWidth={2.4} aria-hidden /> : i + 1}
              </span>
              {/* A phone has room for the current step's name only. */}
              <span className={cn(i !== current && "max-sm:sr-only")}>{s}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 w-full max-w-[320px]">
        <Bar value={job?.progress ?? 0} />
        <p className="mt-2 text-[12px] text-muted-foreground" aria-live="polite">
          {job?.stage ? STAGE_LABEL[job.stage] : "排队中"}
        </p>
      </div>
    </Centered>
  );
}

export function Bar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-clay transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Centered({ art, title, text, children }: { art: React.ReactNode; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
      {art}
      <h2 className="serif mt-5 text-[24px]">{title}</h2>
      <p className="mt-2 max-w-[440px] text-[13.5px] leading-relaxed text-muted-foreground">{text}</p>
      <div className="mt-5 flex flex-col items-center gap-2">{children}</div>
    </div>
  );
}
