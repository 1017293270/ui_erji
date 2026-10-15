import { useEffect, type ReactNode } from "react";
import { CircleUserRound, ListMusic } from "lucide-react";
import { applyTheme, cn } from "@echomind/ui";
import { Toasts } from "../components/Shell";
import { captureStatus, keepWorking, unsavedRecordings } from "../lib/native";
import { href, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmTodos } from "../pages/ConfirmTodos";
import { MobileHome } from "./Home";
import { MobileMe } from "./Me";
import { MobileMeeting } from "./Meeting";
import { RecordingScreen } from "./Recording";

/**
 * The phone app: record a meeting in the room, read its minutes, confirm its todos. Only
 * meetings recorded on this phone are here; their audio and transcript never leave it.
 */
export function MobileApp() {
  const { route } = useLocation();
  const store = useStore();

  // There is no theme switch on the phone: follow the system, also when it changes at night.
  useEffect(() => {
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    follow();
    dark.addEventListener("change", follow);
    return () => dark.removeEventListener("change", follow);
  }, []);

  // A recording keeps going while the app is closed. Coming back, the page picks it up, and makes
  // meetings of recordings that ended meanwhile, or that Android cut short.
  const { dispatch } = store;
  useEffect(() => {
    void captureStatus()
      .then(async (status) => {
        if (status.recording) {
          dispatch({ type: "capture", keepMeeting: true, event: { type: "started", startedAt: status.startedAt, out: status.out } });
          for (const atMs of status.marks) dispatch({ type: "capture", keepMeeting: true, event: { type: "mark", atMs } });
          if (status.paused) dispatch({ type: "capture", keepMeeting: true, event: { type: "paused", atMs: status.elapsedMs } });
        }
        const live = status.recording ? (status.out.split("/").pop() ?? null) : null;
        dispatch({ type: "recovered", recordings: await unsavedRecordings(live) });
      })
      .catch(() => {});
  }, [dispatch]);

  // The models come with the app; unpack them on the first run, before any meeting needs them.
  const needsModels = !!store.models && !store.models.ready;
  const { downloadModels } = store;
  useEffect(() => {
    if (needsModels) void downloadModels();
  }, [needsModels, downloadModels]);

  // Transcribing and summarising go on with the screen off; a failed job waits for the person.
  const working = Object.values(store.jobs).some((job) => !job.error);
  useEffect(() => {
    void keepWorking(working).catch(() => {});
  }, [working]);

  let screen: ReactNode;
  if (store.recording) screen = <RecordingScreen />;
  else if (route.name === "meeting") screen = <MobileMeeting id={route.id} />;
  else if (route.name === "confirm") {
    screen = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConfirmTodos id={route.id} />
      </div>
    );
  } else {
    screen = (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto">{route.name === "settings" ? <MobileMe /> : <MobileHome />}</div>
        <TabBar current={route.name === "settings" ? "me" : "meetings"} />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {screen}
      <Toasts />
    </div>
  );
}

function TabBar({ current }: { current: "meetings" | "me" }) {
  const tabs = [
    { id: "meetings", label: "会议", to: "/", icon: ListMusic },
    { id: "me", label: "我的", to: "/settings", icon: CircleUserRound },
  ] as const;
  return (
    <nav className="flex shrink-0 border-t border-border bg-background">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={href(t.to)}
          className={cn("flex flex-1 flex-col items-center gap-0.5 pt-2 pb-2.5 text-[11.5px]", current === t.id ? "text-foreground" : "text-subtle")}
          aria-current={current === t.id ? "page" : undefined}
        >
          <t.icon className="size-[21px]" strokeWidth={current === t.id ? 2 : 1.6} aria-hidden />
          {t.label}
        </a>
      ))}
    </nav>
  );
}
