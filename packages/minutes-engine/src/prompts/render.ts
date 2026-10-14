import type { Chapter, Person, Segment, Speaker } from "@echomind/shared";

/**
 * Compact text views of a meeting for the model. One line per segment so the
 * model can cite ids, with names instead of diarization labels where known:
 *
 *   [seg-0012 06:53 李娜] 那如果用户开的是外放……
 */

/** 06:53, or 1:02:03 past the hour. */
export function stamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export type People = ReadonlyMap<string, Person>;

export function peopleById(...lists: (readonly Person[] | undefined)[]): Map<string, Person> {
  const map = new Map<string, Person>();
  for (const list of lists) for (const p of list ?? []) if (!map.has(p.id)) map.set(p.id, p);
  return map;
}

/** The person's name when the speaker is named, else the label: 说话人 5. */
export function speakerName(speaker: Speaker | undefined, people: People, fallbackId = "?"): string {
  if (!speaker) return `说话人 ${fallbackId}`;
  const person = speaker.personId ? people.get(speaker.personId) : undefined;
  return person?.name ?? speaker.label;
}

const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, " ").trim();

export function renderSegment(seg: Segment, speakers: ReadonlyMap<string, Speaker>, people: People): string {
  return `[${seg.id} ${stamp(seg.start)} ${speakerName(speakers.get(seg.speakerId), people, seg.speakerId)}] ${oneLine(seg.text)}`;
}

export function renderTranscript(segments: readonly Segment[], speakers: readonly Speaker[], people: People): string {
  const bySpeaker = new Map(speakers.map((s) => [s.id, s]));
  return segments.map((seg) => renderSegment(seg, bySpeaker, people)).join("\n");
}

/** - 说话人 2：王磊（研发部 后端工程师） */
export function renderSpeakers(speakers: readonly Speaker[], people: People, recorderId?: string): string {
  return speakers
    .map((s) => {
      const person = s.personId ? people.get(s.personId) : undefined;
      if (!person) return `- ${s.label}：未识别身份`;
      const notes = [[person.department, person.title].filter(Boolean).join(" "), person.external && person.company ? `外部：${person.company}` : "", person.id === recorderId ? "记录人" : ""].filter(Boolean);
      return `- ${s.label}：${person.name}${notes.length ? `（${notes.join("，")}）` : ""}`;
    })
    .join("\n");
}

/** - 王磊（研发部 后端工程师；也叫：小王、磊哥） */
export function renderPeople(people: readonly Person[]): string {
  return people
    .map((p) => {
      const role = [p.external && p.company ? `外部：${p.company}` : p.department, p.title].filter(Boolean).join(" ");
      const aliases = p.aliases?.length ? `也叫：${p.aliases.join("、")}` : "";
      const notes = [role, aliases].filter(Boolean).join("；");
      return `- ${p.name}${notes ? `（${notes}）` : ""}`;
    })
    .join("\n");
}

/** 1. 录音采集方案（seg-0009–seg-0026，04:20–15:20）：摘要 */
export function renderChapters(chapters: readonly Chapter[]): string {
  return chapters
    .map((c, i) => `${i + 1}. ${c.title}（${c.firstSegmentId}–${c.lastSegmentId}，${stamp(c.start)}–${stamp(c.end)}）${c.summary ? `：${c.summary}` : ""}`)
    .join("\n");
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 2026-10-12（周一）, the meeting day in Asia/Shanghai. */
export function renderDate(iso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return `${day}（${WEEKDAYS[wd]}）`;
}

/** 35 分钟 / 1 小时 12 分 */
export function renderDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
