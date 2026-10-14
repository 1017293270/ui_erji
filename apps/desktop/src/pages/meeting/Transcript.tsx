import { useEffect, useMemo, useRef, useState } from "react";
import { Flag, Pause, Play, Search, X } from "lucide-react";
import type { Chapter, Segment } from "@echomind/shared";
import { clock } from "@echomind/shared";
import { cn } from "@echomind/ui";
import { SpeakerDot } from "../../components/ui";
import { speakerName, speakerTone, useStore } from "../../lib/store";
import { useDetail } from "./context";

/** The chapter list on the left; the open chapter follows the playhead. */
export function ChapterRail({ chapters }: { chapters: Chapter[] }) {
  const { currentMs, jump } = useDetail();
  const active = [...chapters].reverse().find((c) => c.start <= currentMs) ?? chapters[0];
  return (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="议题">
      <p className="px-2.5 pt-1 pb-2 text-[12px] text-muted-foreground">议题 · {chapters.length}</p>
      {chapters.map((c, i) => (
        <button
          key={c.id}
          onClick={() => jump(c.firstSegmentId)}
          className={cn(
            "no-drag group flex gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-colors",
            active?.id === c.id ? "bg-card shadow-soft" : "hover:bg-accent/70",
          )}
        >
          <span className={cn("serif num w-4 shrink-0 text-[15px] leading-5", active?.id === c.id ? "text-clay-text" : "text-subtle")}>{i + 1}</span>
          <span className="min-w-0">
            <span className="block text-[13.5px] leading-5 font-medium">{c.title}</span>
            <span className="num mt-0.5 block text-[11.5px] text-muted-foreground">
              {clock(c.start)} – {clock(c.end)}
            </span>
          </span>
        </button>
      ))}
    </nav>
  );
}

type Block = { chapter?: Chapter; turns: Segment[][] };

/** Segments grouped by chapter, then into turns (consecutive lines from one voice). */
function useBlocks(segments: Segment[], chapters: Chapter[]): Block[] {
  return useMemo(() => {
    const blocks: Block[] = [];
    let ci = -1;
    for (const s of segments) {
      const chapterIndex = chapters.findIndex((c) => s.start >= c.start && s.start <= c.end);
      if (!blocks.length || (chapterIndex !== -1 && chapterIndex !== ci)) {
        ci = chapterIndex;
        blocks.push({ chapter: chapters[chapterIndex], turns: [] });
      }
      const block = blocks[blocks.length - 1]!;
      const last = block.turns[block.turns.length - 1];
      if (last && last[0]!.speakerId === s.speakerId) last.push(s);
      else block.turns.push([s]);
    }
    return blocks;
  }, [segments, chapters]);
}

export function TranscriptView({ chapters, onNameSpeaker }: { chapters: Chapter[]; onNameSpeaker: (speakerId: string) => void }) {
  const store = useStore();
  const { segments, speakers, currentMs, seek, flash, registerLine, meeting } = useDetail();
  const blocks = useBlocks(segments, chapters);
  const [query, setQuery] = useState("");
  const playing = useMemo(() => {
    let id: string | undefined;
    for (const s of segments) if (s.start <= currentMs) id = s.id;
    return id;
  }, [segments, currentMs]);
  const hits = query.trim() ? segments.filter((s) => s.text.includes(query.trim())).length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-8 py-2.5">
        <label className="flex h-8 flex-1 items-center gap-2 rounded-[9px] px-1 text-[13px] focus-within:bg-card">
          <Search className="size-3.5 text-subtle" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="在逐字稿中查找"
            className="h-full flex-1 bg-transparent outline-none placeholder:text-subtle"
          />
          {query ? (
            <>
              <span className="num text-[12px] text-muted-foreground">{hits} 处</span>
              <button aria-label="清除" onClick={() => setQuery("")} className="text-subtle hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </>
          ) : null}
        </label>
        <span className="text-[12px] text-muted-foreground">
          {segments.length} 句 · {speakers.size} 位说话人
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-4 pb-10">
        {blocks.map((block, bi) => (
          <section key={block.chapter?.id ?? bi} className="mb-2">
            {block.chapter ? (
              <h3 className="sticky top-[-16px] z-10 -mx-8 mb-1 bg-background/95 px-8 pt-4 pb-2 backdrop-blur-[2px]">
                <span className="serif text-[17px]">{block.chapter.title}</span>
                <span className="num ml-2 text-[12px] text-muted-foreground">{clock(block.chapter.start)}</span>
              </h3>
            ) : null}
            {block.turns.map((turn) => {
              const speaker = speakers.get(turn[0]!.speakerId);
              const tone = speakerTone(turn[0]!.speakerId);
              const unnamed = !speaker?.personId;
              return (
                <div key={turn[0]!.id} className="mt-3.5">
                  <div className="mb-1 flex items-center gap-2 pl-12">
                    <SpeakerDot tone={tone} />
                    <span className="text-[13px] font-medium" style={{ color: `var(--sp-${tone})` }}>
                      {speakerName(store, speaker)}
                    </span>
                    {speaker?.source === "self" ? <span className="text-[11.5px] text-subtle">本人 · 麦克风</span> : null}
                    {unnamed ? (
                      <button onClick={() => onNameSpeaker(turn[0]!.speakerId)} className="no-drag rounded-full bg-clay-soft px-2 py-px text-[11.5px] text-clay-text hover:opacity-80">
                        命名
                      </button>
                    ) : null}
                  </div>
                  {turn.map((s) => (
                    <Line
                      key={s.id}
                      segment={s}
                      active={playing === s.id}
                      query={query.trim()}
                      flashN={flash?.id === s.id ? flash.n : 0}
                      marked={meeting.marks.some((m) => m >= s.start && m <= s.end)}
                      onSeek={() => seek(s.start)}
                      register={(el) => registerLine(s.id, el)}
                    />
                  ))}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <Player />
    </div>
  );
}

function Line({
  segment,
  active,
  query,
  flashN,
  marked,
  onSeek,
  register,
}: {
  segment: Segment;
  active: boolean;
  query: string;
  flashN: number;
  marked: boolean;
  onSeek: () => void;
  register: (el: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={register}
      key={flashN}
      className={cn("group -mx-3 flex gap-3 rounded-[10px] px-3 py-1.5 transition-colors", active && "bg-card shadow-soft", flashN > 0 && "cited")}
    >
      <button onClick={onSeek} className="no-drag num mt-[3px] w-[36px] shrink-0 text-right text-[11.5px] text-subtle hover:text-clay-text" title="从这里播放">
        {clock(segment.start)}
      </button>
      <p className="selectable min-w-0 flex-1 text-[14.5px] leading-[1.8] text-foreground/90">
        {query ? highlight(segment.text, query) : segment.text}
        {marked ? <Flag className="ml-1.5 inline size-3.5 -translate-y-px text-clay" aria-label="录制时标记的重点" /> : null}
      </p>
    </div>
  );
}

function highlight(text: string, query: string) {
  const parts = text.split(query);
  return parts.flatMap((p, i) =>
    i === 0 ? [p] : [<mark key={i} className="rounded-[3px] bg-clay-soft px-0.5 text-clay-text">{query}</mark>, p],
  );
}

const BARS = 220;

/** Deterministic bar heights, so the waveform looks the same every time. */
function noise(i: number) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The player: a waveform colored by who is talking, the marks made while
 * recording, and the playhead. The sample meeting has no audio file, so play
 * only moves the playhead.
 */
function Player() {
  const { meeting, segmentAt, currentMs, playing, toggle, seek, speed, setSpeed } = useDetail();
  const bar = useRef<HTMLDivElement>(null);
  const bars = useMemo(
    () =>
      Array.from({ length: BARS }, (_, i) => {
        const t = ((i + 0.5) / BARS) * meeting.durationMs;
        const s = segmentAt(t);
        const speaking = s && t <= s.end;
        return {
          tone: speaking ? speakerTone(s.speakerId) : 0,
          h: speaking ? 0.32 + noise(i) * 0.68 : 0.08 + noise(i) * 0.06,
        };
      }),
    [meeting.durationMs, segmentAt],
  );
  const progress = meeting.durationMs ? currentMs / meeting.durationMs : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className="flex items-center gap-4 border-t border-border bg-card/60 px-6 py-3">
      <button
        onClick={toggle}
        aria-label={playing ? "暂停" : "播放"}
        className="no-drag grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
      >
        {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
      </button>
      <span className="num w-[92px] shrink-0 text-[12.5px] text-muted-foreground">
        <span className="text-foreground">{clock(currentMs)}</span> / {clock(meeting.durationMs)}
      </span>
      <div
        ref={bar}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={meeting.durationMs}
        aria-valuenow={currentMs}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") seek(currentMs + 5000);
          if (e.key === "ArrowLeft") seek(currentMs - 5000);
        }}
        onClick={(e) => {
          const r = bar.current!.getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * meeting.durationMs);
        }}
        className="no-drag relative flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-px"
      >
        {bars.map((b, i) => (
          <span
            key={i}
            className="flex-1 rounded-full transition-opacity"
            style={{
              height: `${b.h * 100}%`,
              background: b.tone ? `var(--sp-${b.tone})` : "var(--input)",
              opacity: i / BARS <= progress ? 1 : 0.38,
            }}
          />
        ))}
        {meeting.marks.map((m) => (
          <span key={m} className="absolute -top-1 size-2 -translate-x-1/2 rotate-45 rounded-[2px] bg-clay" style={{ left: `${(m / meeting.durationMs) * 100}%` }} title={`标记 · ${clock(m)}`} />
        ))}
        <span className="absolute inset-y-0 w-0.5 rounded-full bg-foreground" style={{ left: `${progress * 100}%` }} />
      </div>
      <button
        onClick={() => setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1)}
        className="no-drag num h-7 w-11 shrink-0 rounded-[8px] border border-border text-[12px] text-muted-foreground hover:text-foreground"
        aria-label="播放速度"
      >
        {speed}×
      </button>
    </div>
  );
}
