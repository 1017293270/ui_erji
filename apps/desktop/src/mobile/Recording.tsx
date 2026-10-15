import { Flag, Pause, Play, Square } from "lucide-react";
import { clock } from "@echomind/shared";
import { cn, MicDoodle } from "@echomind/ui";
import { sendCapture } from "../lib/native";
import { useStore } from "../lib/store";

const BARS = 28;

/**
 * The whole screen while a meeting is being recorded. It keeps recording with the screen
 * off or the app in the background; the notification has a stop button too.
 */
export function RecordingScreen() {
  const { recording } = useStore();
  if (!recording) return null;
  const { paused, elapsed, marks } = recording;

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pt-8 pb-8">
      <div className="flex items-center justify-center gap-2 text-[13px]">
        <span className={cn("size-2 rounded-full", paused ? "bg-subtle" : "rec-dot bg-destructive")} aria-hidden />
        <span className={paused ? "text-muted-foreground" : "text-foreground"}>{paused ? "已暂停" : "正在记录"}</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <MicDoodle className="w-[96px]" live={!paused} />
        <p className="serif num mt-6 text-[56px] leading-none tracking-tight" aria-live="off">
          {clock(elapsed)}
        </p>
        <Level db={paused ? -90 : recording.mic} />
        <p className="mt-6 max-w-[280px] text-center text-[13px] leading-relaxed text-muted-foreground">
          {paused ? "暂停的这段不会录进去。" : "可以锁屏或切到别的 App，录音会继续。录音只保存在这台手机上。"}
        </p>
      </div>

      <div className="flex items-end justify-center gap-7">
        <Control label={`标记重点${marks.length ? ` · ${marks.length}` : ""}`} onClick={() => void sendCapture("mark")} disabled={paused}>
          <Flag className="size-5" strokeWidth={1.8} />
        </Control>
        <Control label={paused ? "继续" : "暂停"} onClick={() => void sendCapture(paused ? "resume" : "pause")} big>
          {paused ? <Play className="size-6 translate-x-0.5" fill="currentColor" /> : <Pause className="size-6" fill="currentColor" />}
        </Control>
        <Control label="结束" onClick={() => void sendCapture("stop")} tone="stop">
          <Square className="size-[18px]" fill="currentColor" />
        </Control>
      </div>
    </div>
  );
}

/** Bars that light up from the left with the microphone's level. */
function Level({ db }: { db: number }) {
  // -60 dBFS is near silence, -12 is loud speech close to the phone.
  const lit = Math.round(Math.min(1, Math.max(0, (db + 60) / 48)) * BARS);
  return (
    <div className="mt-6 flex h-6 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className={cn("w-[4px] rounded-full transition-[height,background-color] duration-100", i < lit ? "bg-clay" : "bg-input")}
          style={{ height: i < lit ? `${45 + ((i * 37) % 55)}%` : "30%" }}
        />
      ))}
    </div>
  );
}

function Control({
  label,
  onClick,
  children,
  big,
  tone,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  big?: boolean;
  tone?: "stop";
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex w-[76px] flex-col items-center gap-2 text-[12px] text-muted-foreground disabled:opacity-40">
      <span
        className={cn(
          "grid place-items-center rounded-full shadow-soft active:scale-95",
          big ? "size-[76px] bg-primary text-primary-foreground" : "size-14 border border-border bg-card",
          !big && (tone === "stop" ? "text-destructive" : "text-foreground"),
        )}
      >
        {children}
      </span>
      {label}
    </button>
  );
}
