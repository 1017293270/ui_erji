import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Feather, Loader2, Mic, Users, Video } from "lucide-react";
import type { MeetingSource, MeetingStatus, Person, TodoStatus } from "@echomind/shared";
import { cn } from "@echomind/ui";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "subtle" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
};

/** Ink is the primary action, never clay: white on clay is below 4.5:1. */
export function Button({ variant = "outline", size = "md", icon, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        "no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition-[background,border-color,box-shadow,opacity] duration-150 disabled:opacity-45",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-9 px-3.5 text-[13.5px]",
        size === "lg" && "h-11 px-5 text-[14.5px]",
        variant === "primary" && "bg-primary text-primary-foreground hover:opacity-90 active:opacity-80",
        variant === "outline" && "border border-border bg-card text-foreground hover:border-input hover:shadow-soft",
        variant === "ghost" && "text-muted-foreground hover:bg-accent hover:text-foreground",
        variant === "subtle" && "bg-secondary text-secondary-foreground hover:bg-sidebar-accent",
        variant === "danger" && "border border-border bg-card text-destructive hover:border-destructive/40",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        "no-drag inline-grid size-8 shrink-0 place-items-center rounded-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = "neutral" | "clay" | "success" | "warning" | "danger" | "outline";

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-secondary text-secondary-foreground",
        tone === "clay" && "bg-clay-soft text-clay-text",
        tone === "success" && "bg-success-soft text-success",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "danger" && "bg-danger-soft text-destructive",
        tone === "outline" && "border border-border text-muted-foreground",
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

const MEETING_STATUS: Record<MeetingStatus, { label: string; tone: Tone }> = {
  recording: { label: "录制中", tone: "clay" },
  transcribing: { label: "转写中", tone: "warning" },
  review: { label: "待确认", tone: "clay" },
  ready: { label: "已生成", tone: "success" },
  pushed: { label: "已推送", tone: "neutral" },
  failed: { label: "失败", tone: "danger" },
};

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  const s = MEETING_STATUS[status];
  return (
    <Badge tone={s.tone} dot={status !== "transcribing"}>
      {status === "transcribing" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {s.label}
    </Badge>
  );
}

export const TODO_STATUS: Record<TodoStatus, { label: string; tone: Tone }> = {
  draft: { label: "待确认", tone: "clay" },
  confirmed: { label: "已确认", tone: "neutral" },
  pushed: { label: "进行中", tone: "outline" },
  done: { label: "已完成", tone: "success" },
  delayed: { label: "已延期", tone: "warning" },
  blocked: { label: "有阻碍", tone: "danger" },
};

export function TodoStatusBadge({ status }: { status: TodoStatus }) {
  const s = TODO_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const SOURCE: Record<MeetingSource, { label: string; Icon: typeof Video }> = {
  tencent: { label: "腾讯会议", Icon: Video },
  feishu: { label: "飞书会议", Icon: Feather },
  zoom: { label: "Zoom", Icon: Video },
  offline: { label: "线下会议", Icon: Users },
  other: { label: "其他", Icon: Mic },
};

export function sourceLabel(source: MeetingSource) {
  return SOURCE[source].label;
}

export function SourceTag({ source, className }: { source: MeetingSource; className?: string }) {
  const { label, Icon } = SOURCE[source];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground", className)}>
      <Icon className="size-3.5" aria-hidden strokeWidth={1.8} />
      {label}
    </span>
  );
}

const AVATAR_TONES = [1, 2, 3, 4, 5, 6];

/** Muted initials; the same person always gets the same tone. */
export function Avatar({ person, size = 28, className, unknown }: { person?: Person; size?: number; className?: string; unknown?: boolean }) {
  if (!person || unknown) {
    return (
      <span
        className={cn("inline-grid shrink-0 place-items-center rounded-full border border-dashed border-input text-muted-foreground", className)}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden
      >
        ?
      </span>
    );
  }
  const tone = AVATAR_TONES[[...person.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-full font-medium", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: `var(--sp-${tone})`,
        background: `color-mix(in srgb, var(--sp-${tone}) 16%, var(--card))`,
      }}
      aria-hidden
    >
      {person.name.slice(0, 1)}
    </span>
  );
}

/** A colored dot for a voice in the transcript. */
export function SpeakerDot({ tone, className }: { tone: number; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: `var(--sp-${tone})` }} aria-hidden />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("no-drag relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-input")}
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] size-4 rounded-full bg-card shadow-sm transition-transform duration-200",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-[11px] bg-secondary p-[3px]", className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "no-drag inline-flex h-7 items-center gap-1.5 rounded-[8px] px-3 text-[13px] whitespace-nowrap transition-colors",
            o.value === value ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="num text-[11.5px] text-subtle">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs, the clay line marks the open one. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-5 border-b border-border", className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "no-drag relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-[13.5px] transition-colors",
            o.value === value ? "border-clay font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="num text-[12px] text-subtle">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-5 min-w-5 place-items-center rounded-[5px] border border-border bg-card px-1 font-sans text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}
