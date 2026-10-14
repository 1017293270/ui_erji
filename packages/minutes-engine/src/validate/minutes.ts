import type { Point } from "@echomind/shared";
import { flagHeavyLoss, type IssueLog } from "./issues";
import type { SegmentIndex } from "./segment-index";

export interface MinutesDraft {
  title: string;
  overview: string;
  conclusions: Point[];
  decisions: Point[];
  openQuestions: Point[];
}

const SECTIONS = [
  ["conclusions", "结论"],
  ["decisions", "决定"],
  ["openQuestions", "待确认问题"],
] as const;

/** Model minutes → points that cite only real segments. Points left with no evidence are dropped. */
export function repairMinutes(json: unknown, index: SegmentIndex, log: IssueLog): MinutesDraft | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    log.fatal("输出不是一个 JSON 对象");
    return null;
  }
  const raw = json as Record<string, unknown>;
  if (SECTIONS.every(([key]) => !Array.isArray(raw[key]))) {
    log.fatal("输出里没有 conclusions / decisions / openQuestions 数组");
    return null;
  }
  const draft: MinutesDraft = {
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    overview: typeof raw.overview === "string" ? raw.overview.trim() : "",
    conclusions: [],
    decisions: [],
    openQuestions: [],
  };
  if (!draft.overview) log.major("overview 为空");

  let total = 0;
  let kept = 0;
  const seen = new Set<string>();
  for (const [key, label] of SECTIONS) {
    const list = raw[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      log.minor(`${key} 不是数组，已忽略`);
      continue;
    }
    for (const item of list) {
      total++;
      const point = repairPoint(item, index, log, label);
      if (!point) continue;
      if (seen.has(point.text)) {
        log.minor(`${label}「${point.text}」重复，已合并`);
        continue;
      }
      seen.add(point.text);
      draft[key].push(point);
      kept++;
    }
  }
  flagHeavyLoss(log, "结论、决定和待确认问题", total, kept);
  return draft;
}

export function repairPoint(item: unknown, index: SegmentIndex, log: IssueLog, label: string): Point | null {
  const record = item && typeof item === "object" ? (item as Record<string, unknown>) : { text: item };
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    log.minor(`有一条${label}没有内容，已删除`);
    return null;
  }
  const unknown: string[] = [];
  const evidence = index.evidence(record.evidence ?? record.segments ?? record.segmentIds, (id) => unknown.push(id));
  if (unknown.length) log.minor(`${label}「${text}」引用了不存在的片段 ${unknown.join("、")}，已去掉`);
  if (!evidence.length) {
    log.minor(`${label}「${text}」没有有效依据，已删除`);
    return null;
  }
  return { text, evidence };
}
