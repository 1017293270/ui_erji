import { Check, Flag, Maximize2, Pause, Play, Square } from "lucide-react";
import { clock } from "@echomind/shared";
import { cn, EchoMark } from "@echomind/ui";
import { IconButton, sourceLabel } from "../components/ui";
import { isTauri, sendCapture, showMainWindow, startCapture } from "../lib/native";
import { useStore } from "../lib/store";

/**
 * The floating recorder: a small always-on-top window while a meeting is
 * being recorded. It is the always-visible sign that recording is on.
 */
export function Recorder() {
  const { recording, dispatch } = useStore();

  return (
    <div className="h-full p-2">
      {/* The whole card moves the window; its buttons stay clickable. */}
      <div data-tauri-drag-region="deep" className="flex h-full flex-col rounded-[18px] border border-border bg-card px-4 pt-3 pb-3 shadow-pop">
        <div className="flex items-center gap-2">
          {recording ? (
            <span className={cn("size-2 rounded-full bg-clay", !recording.paused && "rec-dot")} />
          ) : (
            <EchoMark className="w-[18px]" />
          )}
          <span className="text-[13px] font-medium">{recording ? (recording.paused ? "已暂停" : "正在记录") : "EchoMind"}</span>
          {recording ? <span className="text-[12px] text-muted-foreground">· {recording.source === "other" ? "会议" : sourceLabel(recording.source)}</span> : null}
          <span className="flex-1" />
          <span className="serif num text-[20px] leading-none">{clock(recording?.elapsed ?? 0)}</span>
        </div>

        <div className="mt-3 grid flex-1 grid-cols-2 gap-4">
          <Meter label="我" db={recording?.mic ?? -90} compact />
          <Meter label="远端" db={recording?.system ?? -90} compact />
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          {recording ? (
            <>
              <IconButton
                label="标记重点"
                onClick={() => {
                  void sendCapture("mark");
                  dispatch({ type: "toast", text: "已标记" });
                }}
              >
                <Flag className="size-4" />
              </IconButton>
              <IconButton label={recording.paused ? "继续" : "暂停"} onClick={() => void sendCapture(recording.paused ? "resume" : "pause")}>
                {recording.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              </IconButton>
              <span className="flex-1 truncate px-1 text-[11.5px] text-subtle">{recording.marks.length ? `${recording.marks.length} 处标记` : recording.micDevice}</span>
              {isTauri ? (
                <IconButton label="打开主窗口" onClick={() => void showMainWindow()}>
                  <Maximize2 className="size-3.5" />
                </IconButton>
              ) : null}
              <button
                onClick={() => void sendCapture("stop")}
                className="no-drag ml-1 inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-primary px-3 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
              >
                <Square className="size-3" fill="currentColor" /> 结束
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 text-[12px] text-muted-foreground">还没有开始记录</span>
              <button
                onClick={() => void startCapture()}
                className="no-drag inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-primary px-3 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
              >
                <span className="size-2 rounded-full bg-clay" /> 开始记录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STEPS = 18;

/** A level meter: -60 dBFS is empty, -6 is full. */
export function Meter({ label, db, ok, compact, className }: { label: string; db: number; ok?: boolean; compact?: boolean; className?: string }) {
  const level = Math.max(0, Math.min(1, (db + 60) / 54));
  const lit = Math.round(level * STEPS);
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span>{label}</span>
        {ok ? <Check className="size-3.5 text-success" strokeWidth={2.6} aria-label="已收到声音" /> : null}
        {!compact ? <span className="num ml-auto text-[11px] text-subtle">{db <= -89 ? "—" : `${Math.round(db)} dB`}</span> : null}
      </div>
      <div className="flex h-2.5 items-stretch gap-[3px]" role="meter" aria-label={`${label}音量`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(db)}>
        {Array.from({ length: STEPS }, (_, i) => (
          <span
            key={i}
            className="flex-1 rounded-[2px] transition-colors duration-75"
            style={{ background: i < lit ? (i >= STEPS - 3 ? "var(--clay)" : "var(--foreground)") : "var(--secondary)" }}
          />
        ))}
      </div>
    </div>
  );
}
