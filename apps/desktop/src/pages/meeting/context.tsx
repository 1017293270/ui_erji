import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Meeting, Segment, Speaker } from "@echomind/shared";
import { recordingUrl } from "../../lib/native";
import { isMobile } from "../../lib/platform";
import { LIVE, useStore } from "../../lib/store";

/**
 * What the panes of the meeting page share: the playhead, and a way to jump
 * to a segment (from a citation, a chapter, a todo) that scrolls the
 * transcript and flashes the line.
 */
type Detail = {
  meeting: Meeting;
  segments: Segment[];
  speakers: Map<string, Speaker>;
  currentMs: number;
  playing: boolean;
  speed: number;
  /** Bumps on every jump so the same line can flash twice. */
  flash: { id: string; n: number } | null;
  seek: (ms: number) => void;
  /** Seeks and plays. */
  playFrom: (ms: number) => void;
  jump: (segmentId: string) => void;
  toggle: () => void;
  setSpeed: (s: number) => void;
  registerLine: (id: string, el: HTMLElement | null) => void;
  segmentAt: (ms: number) => Segment | undefined;
};

const Ctx = createContext<Detail | null>(null);

/** `onJump` runs before jumping to a line: the phone shows the transcript tab first. */
export function DetailProvider({
  meeting,
  initialSegment,
  onJump,
  children,
}: {
  meeting: Meeting;
  initialSegment?: string | null;
  onJump?: () => void;
  children: ReactNode;
}) {
  const store = useStore();
  const segments = useMemo(() => meeting.transcript?.segments ?? [], [meeting.transcript]);
  const speakers = useMemo(() => new Map((meeting.transcript?.speakers ?? []).map((s) => [s.id, s])), [meeting.transcript]);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [flash, setFlash] = useState<Detail["flash"]>(null);
  const lines = useRef(new Map<string, HTMLElement>());
  /** A line jumped to before it was on screen, scrolled to once it is. */
  const pending = useRef<string | null>(null);
  // Callers pass a new onJump on every render; jumping does not change with it.
  const onJumpLatest = useRef(onJump);
  onJumpLatest.current = onJump;

  // In the app the recording plays (playback.rs mixes both tracks); the playhead follows it.
  const audio = useRef<HTMLAudioElement | null>(null);
  const missing = useRef(false);
  useEffect(() => {
    if (!LIVE) return;
    const a = new Audio();
    a.preload = "metadata";
    audio.current = a;
    missing.current = false;
    recordingUrl(meeting.id).then(
      (url) => {
        if (audio.current === a) a.src = url;
      },
      () => (missing.current = true),
    );
    let frame = 0;
    const follow = () => {
      setCurrentMs(a.currentTime * 1000);
      frame = requestAnimationFrame(follow);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    };
    const onStop = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      setCurrentMs(a.currentTime * 1000);
    };
    const onError = () => {
      missing.current = true;
      onStop();
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onStop);
    a.addEventListener("error", onError);
    return () => {
      cancelAnimationFrame(frame);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onStop);
      a.removeEventListener("error", onError);
      a.pause();
      a.removeAttribute("src");
      a.load();
      audio.current = null;
    };
  }, [meeting.id]);

  const seek = useCallback(
    (ms: number) => {
      const to = Math.max(0, Math.min(meeting.durationMs, ms));
      setCurrentMs(to);
      if (audio.current) audio.current.currentTime = to / 1000;
    },
    [meeting.durationMs],
  );

  const play = useCallback(() => {
    const a = audio.current;
    if (!a) return setPlaying(true);
    if (missing.current) return store.toast(`这场会议的录音文件不在这台${isMobile ? "手机" : "电脑"}上了，只能看文字稿。`, "error");
    a.playbackRate = speed;
    a.play().catch((e: unknown) => store.toast(`播放失败：${String(e)}`, "error"));
  }, [store, speed]);

  // The sample meeting has no recording, so its playhead runs on a timer.
  useEffect(() => {
    if (LIVE || !playing) return;
    const timer = setInterval(() => {
      setCurrentMs((ms) => {
        const next = ms + 100 * speed;
        if (next >= meeting.durationMs) {
          setPlaying(false);
          return meeting.durationMs;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(timer);
  }, [playing, speed, meeting.durationMs]);

  const segmentAt = useCallback(
    (ms: number) => {
      let found: Segment | undefined;
      for (const s of segments) {
        if (s.start > ms) break;
        found = s;
      }
      return found;
    },
    [segments],
  );

  const jump = useCallback(
    (id: string) => {
      const seg = segments.find((s) => s.id === id);
      if (!seg) return;
      seek(seg.start);
      setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      onJumpLatest.current?.();
      const line = lines.current.get(id);
      if (line) line.scrollIntoView({ block: "center", behavior: "smooth" });
      else pending.current = id;
    },
    [segments, seek],
  );

  // The line a link points at, once per meeting and link: not again when the transcript changes.
  const jumpLatest = useRef(jump);
  jumpLatest.current = jump;
  useEffect(() => {
    if (!initialSegment) return;
    const t = setTimeout(() => jumpLatest.current(initialSegment), 120);
    return () => clearTimeout(t);
  }, [meeting.id, initialSegment]);

  const value = useMemo<Detail>(
    () => ({
      meeting,
      segments,
      speakers,
      currentMs,
      playing,
      speed,
      flash,
      seek,
      playFrom: (ms) => {
        seek(ms);
        play();
      },
      jump,
      toggle: () => {
        if (!playing) play();
        else if (audio.current) audio.current.pause();
        else setPlaying(false);
      },
      setSpeed: (s) => {
        setSpeed(s);
        if (audio.current) audio.current.playbackRate = s;
      },
      registerLine: (id, el) => {
        if (el) lines.current.set(id, el);
        else lines.current.delete(id);
        if (el && pending.current === id) {
          pending.current = null;
          requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
        }
      },
      segmentAt,
    }),
    [meeting, segments, speakers, currentMs, playing, speed, flash, seek, play, jump, segmentAt],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDetail(): Detail {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDetail outside DetailProvider");
  return v;
}
