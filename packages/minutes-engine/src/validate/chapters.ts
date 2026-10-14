import { z } from "zod";
import { Chapter } from "@echomind/shared";
import type { IssueLog } from "./issues";
import type { SegmentIndex } from "./segment-index";

/** What we accept from the model; field names it sometimes uses instead are mapped over. */
const RawChapter = z.object({
  title: z.string().nullish(),
  summary: z.string().nullish(),
  startSegmentId: z.unknown(),
  endSegmentId: z.unknown(),
});

/** A gap the size of a few lines is noise; a bigger one means the model skipped a topic. */
const SMALL_GAP_SEGMENTS = 8;
const SMALL_GAP_MS = 5 * 60_000;

export function listOf(json: unknown, key: string): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const value = (json as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

interface Span {
  title: string;
  summary: string;
  s: number;
  e: number;
}

/**
 * Model chapters → contiguous, ordered, non-overlapping chapters that cover
 * every segment of `index`. Unknown ids, overlaps and gaps are repaired
 * deterministically; each repair is logged.
 */
export function repairChapters(json: unknown, index: SegmentIndex, log: IssueLog, idOffset = 0): Chapter[] | null {
  const list = listOf(json, "chapters");
  if (!list) {
    log.fatal("输出里没有 chapters 数组");
    return null;
  }
  if (index.size === 0) return [];

  const partial: { title: string; summary: string; s: number | null; e: number | null }[] = [];
  list.forEach((item, i) => {
    const normalized =
      item && typeof item === "object"
        ? {
            ...(item as Record<string, unknown>),
            startSegmentId: pick(item, "startSegmentId", "firstSegmentId", "start", "startId"),
            endSegmentId: pick(item, "endSegmentId", "lastSegmentId", "end", "endId"),
          }
        : item;
    const parsed = RawChapter.safeParse(normalized);
    if (!parsed.success) {
      log.minor(`第 ${i + 1} 章格式不对，已忽略`);
      return;
    }
    const c = parsed.data;
    const title = (c.title ?? "").trim();
    const startId = index.resolve(c.startSegmentId);
    const endId = index.resolve(c.endSegmentId);
    const label = `第 ${i + 1} 章「${title || "无标题"}」`;
    if (!startId && !endId) {
      log.minor(`${label}的起止编号 ${show(c.startSegmentId)} / ${show(c.endSegmentId)} 都不存在，已删除`);
      return;
    }
    if (!startId) log.minor(`${label}的起始编号 ${show(c.startSegmentId)} 不存在，按前后章节推断`);
    if (!endId) log.minor(`${label}的结束编号 ${show(c.endSegmentId)} 不存在，按前后章节推断`);
    partial.push({
      title,
      summary: (c.summary ?? "").trim(),
      s: startId ? index.indexOf(startId) : null,
      e: endId ? index.indexOf(endId) : null,
    });
  });

  if (!partial.length) {
    log.fatal("没有一个章节引用了真实存在的片段编号");
    return null;
  }
  if (list.length >= 2 && partial.length * 2 < list.length) {
    log.major(`共 ${list.length} 个章节，只有 ${partial.length} 个引用了真实存在的片段编号`);
  }

  partial.sort((a, b) => (a.s ?? a.e!) - (b.s ?? b.e!));
  const last = index.size - 1;
  const spans: Span[] = partial.map((p, i) => {
    const prev = partial[i - 1];
    const next = partial[i + 1];
    let s = p.s ?? (prev ? (prev.e ?? prev.s!) + 1 : 0);
    let e = p.e ?? (next ? (next.s ?? next.e!) - 1 : last);
    s = clamp(s, 0, last);
    e = clamp(e, 0, last);
    if (s > e) {
      log.minor(`「${p.title || "无标题"}」的起止顺序颠倒，已对调`);
      [s, e] = [e, s];
    }
    return { title: p.title, summary: p.summary, s, e };
  });
  spans.sort((a, b) => a.s - b.s || b.e - a.e);

  const out: Span[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(span);
      continue;
    }
    if (span.e <= prev.e) {
      log.minor(`「${span.title || "无标题"}」完全落在「${prev.title || "无标题"}」之内，已并入`);
      continue;
    }
    if (span.s <= prev.e) {
      // Overlap: trust where the later topic says it starts.
      log.minor(`「${prev.title || "无标题"}」与「${span.title || "无标题"}」在 ${index.at(span.s).id}–${index.at(prev.e).id} 重叠，已按后一章的起点切开`);
      prev.e = span.s - 1;
      if (prev.e < prev.s) {
        out.pop();
        log.minor(`「${prev.title || "无标题"}」切开后为空，已删除`);
        const before = out[out.length - 1];
        if (before && span.s > before.e + 1) before.e = span.s - 1;
        if (!before) span.s = 0;
      }
    } else if (span.s > prev.e + 1) {
      noteGap(log, index, prev.e + 1, span.s - 1, `「${prev.title || "无标题"}」和「${span.title || "无标题"}」之间`, `并入「${prev.title || "无标题"}」`);
      prev.e = span.s - 1;
    }
    out.push(span);
  }

  const first = out[0]!;
  if (first.s > 0) {
    noteGap(log, index, 0, first.s - 1, "开头", `并入「${first.title || "无标题"}」`);
    first.s = 0;
  }
  const end = out[out.length - 1]!;
  if (end.e < last) {
    noteGap(log, index, end.e + 1, last, "结尾", `并入「${end.title || "无标题"}」`);
    end.e = last;
  }

  return out.map((span, i) =>
    Chapter.parse({
      id: `ch-${idOffset + i + 1}`,
      title: span.title || `第 ${idOffset + i + 1} 部分`,
      summary: span.summary,
      start: index.at(span.s).start,
      end: index.at(span.e).end,
      firstSegmentId: index.at(span.s).id,
      lastSegmentId: index.at(span.e).id,
    }),
  );
}

function noteGap(log: IssueLog, index: SegmentIndex, from: number, to: number, where: string, fix: string): void {
  const count = to - from + 1;
  const ms = index.at(to).end - index.at(from).start;
  const message = `${where}有 ${count} 个片段（${index.at(from).id}–${index.at(to).id}）没有归入任何章节，已${fix}`;
  if (count <= SMALL_GAP_SEGMENTS && ms <= SMALL_GAP_MS) log.minor(message);
  else log.major(message);
}

function pick(item: object, ...keys: string[]): unknown {
  const record = item as Record<string, unknown>;
  for (const k of keys) if (record[k] !== undefined && record[k] !== null) return record[k];
  return undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const show = (v: unknown) => (v === undefined || v === null ? "（空）" : `「${String(v)}」`);
