import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Meeting, Segment, Speaker } from "@echomind/shared";

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
  jump: (segmentId: string) => void;
  toggle: () => void;
  setSpeed: (s: number) => void;
  registerLine: (id: string, el: HTMLElement | null) => void;
  segmentAt: (ms: number) => Segment | undefined;
};

const Ctx = createContext<Detail | null>(null);

export function DetailProvider({ meeting, initialSegment, children }: { meeting: Meeting; initialSegment?: string | null; children: ReactNode }) {
  const segments = useMemo(() => meeting.transcript?.segments ?? [], [meeting.transcript]);
  const speakers = useMemo(() => new Map((meeting.transcript?.speakers ?? []).map((s) => [s.id, s])), [meeting.transcript]);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [flash, setFlash] = useState<Detail["flash"]>(null);
  const lines = useRef(new Map<string, HTMLElement>());

  // The sample meeting has no audio file, so the playhead runs on a timer.
  useEffect(() => {
    if (!playing) return;
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
      setCurrentMs(seg.start);
      setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      lines.current.get(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [segments],
  );

  useEffect(() => {
    if (!initialSegment) return;
    const t = setTimeout(() => jump(initialSegment), 120);
    return () => clearTimeout(t);
  }, [initialSegment, jump]);

  const value = useMemo<Detail>(
    () => ({
      meeting,
      segments,
      speakers,
      currentMs,
      playing,
      speed,
      flash,
      seek: (ms) => setCurrentMs(Math.max(0, Math.min(meeting.durationMs, ms))),
      jump,
      toggle: () => setPlaying((p) => !p),
      setSpeed,
      registerLine: (id, el) => {
        if (el) lines.current.set(id, el);
        else lines.current.delete(id);
      },
      segmentAt,
    }),
    [meeting, segments, speakers, currentMs, playing, speed, flash, jump, segmentAt],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDetail(): Detail {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDetail outside DetailProvider");
  return v;
}
