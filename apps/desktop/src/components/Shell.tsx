import { useEffect, useState, type ReactNode } from "react";
import {
  AudioLines,
  ChevronsUpDown,
  LayoutGrid,
  ListChecks,
  Moon,
  Pause,
  Play,
  Search,
  Settings2,
  Square,
  Sun,
  UsersRound,
  AudioWaveform,
  X,
} from "lucide-react";
import { clock } from "@echomind/shared";
import { applyTheme, cn, EchoMark, MicDoodle } from "@echomind/ui";
import { href, navigate, useLocation, type Route } from "../lib/router";
import { useStore } from "../lib/store";
import { openPrivacySettings, sendCapture, startCapture } from "../lib/native";
import { isMac, isWindows } from "../lib/platform";
import { Avatar, Button, IconButton, Kbd, sourceLabel } from "./ui";
import { FeishuAvatar } from "./Feishu";

type NavKey = "home" | "meetings" | "todos" | "team" | "people" | "settings";

const NAV: { key: NavKey; label: string; to: string; Icon: typeof LayoutGrid }[] = [
  { key: "home", label: "工作台", to: "/", Icon: LayoutGrid },
  { key: "meetings", label: "会议", to: "/meetings", Icon: AudioLines },
  { key: "todos", label: "待办", to: "/todos", Icon: ListChecks },
  { key: "team", label: "团队", to: "/team", Icon: UsersRound },
  { key: "people", label: "人员与声纹", to: "/people", Icon: AudioWaveform },
];

function activeNav(route: Route): NavKey {
  switch (route.name) {
    case "meetings":
    case "meeting":
    case "confirm":
      return "meetings";
    case "todos":
    case "team":
    case "people":
    case "settings":
      return route.name;
    case "companies":
      return "settings";
    default:
      return "home";
  }
}

export function Shell({ children, crumbs }: { children: ReactNode; crumbs: string[] }) {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar crumbs={crumbs} />
        <DetectedBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}

function Sidebar() {
  const { route } = useLocation();
  const store = useStore();
  const active = activeNav(route);
  const me = store.person(store.me);
  const account = store.feishu?.user;
  const counts: Partial<Record<NavKey, number>> = {
    meetings: store.meetings.length,
    todos: store.todos.filter((t) => t.ownerPersonId === store.me && t.status !== "done").length,
  };

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div data-tauri-drag-region="deep" className="drag h-[38px] shrink-0 [.platform-mac_&]:h-[46px] [.platform-win_&]:h-4" />
      <a href={href("/")} className="no-drag mx-4 mb-5 flex items-center gap-2.5">
        <EchoMark className="w-[30px]" />
        <span className="leading-tight">
          <span className="serif block text-[17px] text-foreground">EchoMind</span>
          <span className="block text-[11.5px] text-muted-foreground">会议纪要助手</span>
        </span>
      </a>

      <nav className="flex flex-col gap-0.5 px-2.5" aria-label="主导航">
        {NAV.map(({ key, label, to, Icon }) => (
          <a
            key={key}
            href={href(to)}
            aria-current={active === key ? "page" : undefined}
            className={cn(
              "no-drag flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] transition-colors",
              active === key ? "bg-sidebar-accent font-medium text-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
            )}
          >
            <Icon className={cn("size-[17px]", active === key ? "text-clay" : "text-muted-foreground")} strokeWidth={1.8} aria-hidden />
            <span className="flex-1">{label}</span>
            {counts[key] !== undefined ? <span className="num text-[12px] text-subtle">{counts[key]}</span> : null}
          </a>
        ))}
      </nav>

      <div className="flex-1" />

      <RecordCard />

      <div className="flex items-center gap-1 border-t border-sidebar-border px-2.5 py-2.5">
        <button className="no-drag flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-sidebar-accent/60">
          {account ? <FeishuAvatar profile={account} size={30} /> : <Avatar person={me} size={30} />}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium">{account?.name ?? me?.name}</span>
            <span className="block truncate text-[11.5px] text-muted-foreground">{account ? "飞书 · 已登录" : `飞书 · ${me?.department ?? ""}`}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-subtle" aria-hidden />
        </button>
        <IconButton label="设置" onClick={() => navigate("/settings")} className={cn(active === "settings" && "bg-sidebar-accent text-foreground")}>
          <Settings2 className="size-[17px]" strokeWidth={1.8} />
        </IconButton>
      </div>
    </aside>
  );
}

/** The sidebar's one drawing: the microphone, alive while a meeting is being recorded. */
function RecordCard() {
  const { recording } = useStore();
  return (
    <div className="card mx-2.5 mb-2.5 px-4 pt-3 pb-4 shadow-soft">
      <MicDoodle className="mx-auto w-[68px]" live={!!recording} />
      {recording ? (
        <>
          <p className="mt-2 text-[13px] font-medium">
            <span className="rec-dot mr-1.5 inline-block size-2 rounded-full bg-clay align-middle" />
            {recording.paused ? "已暂停" : "正在记录"} · <span className="num">{clock(recording.elapsed)}</span>
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">麦克风和系统声音两路一起录，结束后自动整理。</p>
        </>
      ) : (
        <>
          <p className="mt-2 text-[13px] font-medium">开会时，点一下开始记录</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">腾讯会议、飞书会议、线下会议都可以。</p>
          <Button variant="primary" size="sm" className="mt-3 w-full" onClick={() => void startCapture()}>
            开始记录
          </Button>
        </>
      )}
    </div>
  );
}

function TopBar({ crumbs }: { crumbs: string[] }) {
  const { recording } = useStore();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  const toggleTheme = () => {
    const next = !dark;
    applyTheme(next ? "dark" : "light");
    setDark(next);
  };

  return (
    <header data-tauri-drag-region="deep" className="drag flex h-12 shrink-0 items-center gap-3 border-b border-border px-5 [.platform-mac_&]:h-[46px]">
      <nav className="flex min-w-0 items-center gap-2 text-[13px]" aria-label="位置">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2">
            {i > 0 ? <span className="text-subtle">/</span> : null}
            <span className={cn("truncate", i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground")}>{c}</span>
          </span>
        ))}
      </nav>
      <div className="flex-1" />
      <button className="no-drag hidden h-8 w-[240px] items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 text-[13px] text-subtle hover:border-input lg:flex">
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">搜索会议、待办、人</span>
        <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
        <Kbd>K</Kbd>
      </button>
      <IconButton label={dark ? "浅色模式" : "深色模式"} onClick={toggleTheme}>
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </IconButton>
      {recording ? <RecordingPill /> : (
        <Button variant="primary" size="sm" onClick={() => void startCapture()} icon={<span className="size-2 rounded-full bg-clay" />}>
          开始记录
        </Button>
      )}
    </header>
  );
}

function RecordingPill() {
  const { recording } = useStore();
  if (!recording) return null;
  return (
    <div className="no-drag flex h-8 items-center gap-1 rounded-full border border-border bg-card pr-1 pl-3 shadow-soft">
      <span className={cn("size-2 rounded-full bg-clay", !recording.paused && "rec-dot")} />
      <span className="num ml-1 w-[52px] text-[13px] font-medium">{clock(recording.elapsed)}</span>
      <IconButton label={recording.paused ? "继续" : "暂停"} className="size-7" onClick={() => void sendCapture(recording.paused ? "resume" : "pause")}>
        {recording.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
      </IconButton>
      <IconButton label="结束记录" className="size-7" onClick={() => void sendCapture("stop")}>
        <Square className="size-3.5" />
      </IconButton>
    </div>
  );
}

function DetectedBanner() {
  const { detected, recording } = useStore();
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!detected || recording || dismissed === detected.pid) return null;
  return (
    <div className="slide-up mx-5 mt-3 flex items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-2.5 shadow-soft">
      <span className="rec-dot size-2 rounded-full bg-clay" />
      <p className="flex-1 text-[13.5px]">
        检测到<span className="font-medium">{sourceLabel(detected.app === "lark" ? "feishu" : detected.app === "zoom" ? "zoom" : detected.app)}</span>正在通话，要开始记录吗？
      </p>
      <Button variant="primary" size="sm" onClick={() => void startCapture()}>
        开始记录
      </Button>
      <IconButton label="忽略" onClick={() => setDismissed(detected.pid)}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

function Toasts() {
  const { toasts, dispatch } = useStore();
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.filter((t) => !t.settings).map((t) => setTimeout(() => dispatch({ type: "dismissToast", id: t.id }), 4200));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dispatch]);

  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "slide-up pointer-events-auto flex items-start gap-3 rounded-[14px] border border-border bg-card px-4 py-3 text-[13.5px] shadow-pop",
            t.tone === "error" && "border-destructive/30",
          )}
        >
          <span
            className={cn(
              "mt-[7px] size-2 shrink-0 rounded-full",
              t.tone === "success" ? "bg-success" : t.tone === "error" ? "bg-destructive" : "bg-clay",
            )}
          />
          <div className="flex-1">
            <p className="leading-relaxed">{t.text}</p>
            {t.settings ? (
              <Button size="sm" className="mt-2" onClick={() => void openPrivacySettings(t.settings!)}>
                {isWindows ? "打开设置" : "打开系统设置"}
              </Button>
            ) : null}
          </div>
          <button className="text-subtle hover:text-foreground" aria-label="关闭" onClick={() => dispatch({ type: "dismissToast", id: t.id })}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Eyebrow, serif title, a line of lead text, and the page's one small drawing on the right. */
export function PageHeader({ eyebrow, title, lead, art, actions }: { eyebrow: string; title: string; lead?: ReactNode; art?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end gap-8">
      <div className="min-w-0 flex-1">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="serif mt-2 text-[34px] leading-[1.15]">{title}</h1>
        {lead ? <p className="mt-2.5 max-w-[560px] text-[14px] leading-relaxed text-muted-foreground">{lead}</p> : null}
        {actions ? <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {art ? <div className="hidden w-[150px] shrink-0 md:block">{art}</div> : null}
    </div>
  );
}
