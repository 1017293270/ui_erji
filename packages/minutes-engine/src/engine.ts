import {
  Chapter,
  Minutes,
  Todo,
  Transcript,
  type Generation,
  type Person,
  type Point,
  type Segment,
  type Speaker,
} from "@echomind/shared";
import { feedback, type TaskName } from "./prompts/common";
import { CHAPTERS_SYSTEM, chaptersUser } from "./prompts/chapters";
import { MINUTES_PROMPT_VERSION, MINUTES_SYSTEM, minutesUser } from "./prompts/minutes";
import { OVERVIEW_SYSTEM, overviewUser } from "./prompts/overview";
import { TODOS_SYSTEM, todosUser } from "./prompts/todos";
import {
  peopleById,
  renderChapters,
  renderDate,
  renderDuration,
  renderPeople,
  renderSegment,
  renderSpeakers,
  type People,
} from "./prompts/render";
import { LlmError } from "./provider/errors";
import type { LlmProvider } from "./provider/types";
import { mergeDuplicateTodos } from "./resolve/dedupe";
import { resolveDue } from "./resolve/due";
import { resolveOwner } from "./resolve/owner";
import { estimateTokens } from "./tokens";
import { UsageMeter } from "./usage";
import { repairChapters } from "./validate/chapters";
import { IssueLog, type Issue } from "./validate/issues";
import { repairMinutes, type MinutesDraft } from "./validate/minutes";
import { SegmentIndex } from "./validate/segment-index";
import { repairTodos, type TodoDraft } from "./validate/todos";

export interface MeetingContext {
  /** When the meeting started: ISO date-time with +08:00. Due dates resolve against its day. */
  meetingDate: string;
  participants: Person[];
  /** The company directory plus known outside contacts. */
  directory: Person[];
  recorderId: string;
  speakers: Speaker[];
  /** The calendar title, a hint for Minutes.title. */
  meetingTitle?: string;
}

export interface MinutesEngine {
  chapters(t: Transcript, ctx?: MeetingContext): Promise<Chapter[]>;
  minutes(t: Transcript, chapters: Chapter[], ctx: MeetingContext): Promise<Minutes>;
  /** Pass the chapters when you have them: long meetings are split along them. */
  todos(t: Transcript, ctx: MeetingContext, chapters?: Chapter[]): Promise<Todo[]>;
}

export interface MinutesEngineOptions {
  provider: LlmProvider;
  /** Names speakers in chapters() when no context is given. */
  directory?: Person[];
  /**
   * Above this many transcript tokens, a task runs per part (along chapter
   * boundaries) and the results are merged. Default 32k tokens, about 53k
   * Chinese characters or three to four hours of speech.
   */
  maxTranscriptTokens?: number;
  /** Parts of a long meeting processed at once. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => Date;
  onIssue?: (issue: Issue) => void;
}

const MAX_TOKENS: Record<TaskName, number> = { chapters: 2048, minutes: 4096, todos: 4096, overview: 1024 };

/** The model's output stayed unusable after the one retry. */
export class MinutesEngineError extends Error {
  readonly task: TaskName;
  readonly issues: Issue[];
  readonly userMessage: string;

  constructor(task: TaskName, issues: Issue[]) {
    const label = { chapters: "章节", minutes: "纪要", todos: "待办", overview: "概述" }[task];
    const userMessage = `模型连续两次生成的${label}都无法使用，请稍后重新生成。`;
    super(`${userMessage}${issues.length ? `问题：${issues.map((i) => i.message).join("；")}` : ""}`);
    this.name = "MinutesEngineError";
    this.task = task;
    this.issues = issues;
    this.userMessage = userMessage;
  }
}

interface Part {
  index: number;
  total: number;
  segments: Segment[];
  chapters: Chapter[];
}

export class DefaultMinutesEngine implements MinutesEngine {
  readonly usage = new UsageMeter();
  readonly issues: Issue[] = [];
  private readonly provider: LlmProvider;
  private readonly options: MinutesEngineOptions;

  constructor(options: MinutesEngineOptions) {
    this.provider = options.provider;
    this.options = options;
  }

  private get budget(): number {
    return this.options.maxTranscriptTokens ?? 32_000;
  }

  async chapters(input: Transcript, ctx?: MeetingContext): Promise<Chapter[]> {
    const t = Transcript.parse(input);
    if (!t.segments.length) return [];
    const view = this.view(t, ctx);
    const parts = this.plan(t.segments, [], view);
    const out: Chapter[] = [];
    for (const part of parts) {
      const index = new SegmentIndex(part.segments);
      const previous = out[out.length - 1];
      const user = chaptersUser({
        speakers: view.speakerList,
        transcript: view.render(part.segments),
        segmentCount: part.segments.length,
        firstId: part.segments[0]!.id,
        lastId: part.segments[part.segments.length - 1]!.id,
        duration: renderDuration(t.segments[t.segments.length - 1]!.end),
        part: parts.length > 1 ? { index: part.index, total: part.total, previousTitle: previous?.title } : undefined,
      });
      const chapters = await this.generate("chapters", CHAPTERS_SYSTEM, user, (json, log) => repairChapters(json, index, log));
      const [first, ...rest] = chapters;
      if (previous && first && sameTitle(previous.title, first.title)) {
        // The topic carried over the cut between parts.
        previous.end = first.end;
        previous.lastSegmentId = first.lastSegmentId;
        previous.summary = [previous.summary, first.summary].filter(Boolean).join(" ");
        out.push(...rest);
      } else {
        out.push(...chapters);
      }
    }
    return out.map((c, i) => Chapter.parse({ ...c, id: `ch-${i + 1}` }));
  }

  async minutes(input: Transcript, chapters: Chapter[], ctx: MeetingContext): Promise<Minutes> {
    const t = Transcript.parse(input);
    if (!t.segments.length) throw new Error("逐字稿为空，无法生成纪要。");
    const view = this.view(t, ctx);
    const parts = this.plan(t.segments, chapters, view);
    const common = {
      date: renderDate(ctx.meetingDate),
      duration: renderDuration(t.segments[t.segments.length - 1]!.end),
      calendarTitle: ctx.meetingTitle,
      participants: renderPeople(ctx.participants),
      speakers: view.speakerList,
    };

    const drafts = await this.mapParts(parts, (part) => {
      const index = new SegmentIndex(part.segments);
      const user = minutesUser({
        ...common,
        chapters: renderChapters(part.chapters.length ? part.chapters : chapters),
        transcript: view.render(part.segments),
        part: parts.length > 1 ? { index: part.index, total: part.total } : undefined,
      });
      return this.generate("minutes", MINUTES_SYSTEM, user, (json, log) => repairMinutes(json, index, log));
    });

    const merged = mergeDrafts(drafts);
    if (parts.length > 1) {
      const summary = await this.generate("overview", OVERVIEW_SYSTEM, overviewUser({
        ...common,
        chapters: renderChapters(chapters),
        parts: drafts
          .map((d, i) =>
            [`### 第 ${i + 1} 部分：${d.title}`, d.overview, ...[...d.conclusions, ...d.decisions, ...d.openQuestions].map((p) => `- ${p.text}`)].join("\n"),
          )
          .join("\n\n"),
      }), (json, log) => {
        const r = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const overview = typeof r.overview === "string" ? r.overview.trim() : "";
        if (!overview) {
          log.fatal("overview 为空");
          return null;
        }
        return { title: typeof r.title === "string" ? r.title.trim() : "", overview };
      });
      merged.title = summary.title || merged.title;
      merged.overview = summary.overview;
    }

    const generation: Generation = {
      provider: this.provider.name,
      model: this.provider.model,
      promptVersion: MINUTES_PROMPT_VERSION,
      generatedAt: shanghaiIso(this.options.now?.() ?? new Date()),
    };
    return Minutes.parse({
      title: merged.title || ctx.meetingTitle || chapters[0]?.title || "会议纪要",
      overview: merged.overview || chapters.map((c) => c.summary).filter(Boolean).join(" "),
      chapters,
      conclusions: merged.conclusions,
      decisions: merged.decisions,
      openQuestions: merged.openQuestions,
      generation,
    });
  }

  async todos(input: Transcript, ctx: MeetingContext, chapters: Chapter[] = []): Promise<Todo[]> {
    const t = Transcript.parse(input);
    if (!t.segments.length) return [];
    const view = this.view(t, ctx);
    const parts = this.plan(t.segments, chapters, view);
    const drafts = await this.mapParts(parts, (part) => {
      const index = new SegmentIndex(part.segments);
      const user = todosUser({
        date: renderDate(ctx.meetingDate),
        participants: renderPeople(ctx.participants),
        speakers: view.speakerList,
        transcript: view.render(part.segments),
        part: parts.length > 1 ? { index: part.index, total: part.total } : undefined,
      });
      return this.generate("todos", TODOS_SYSTEM, user, (json, log) => repairTodos(json, index, log));
    });

    const index = new SegmentIndex(t.segments);
    const segments = new Map(t.segments.map((s) => [s.id, s]));
    const owners = { segments, speakers: view.speakers, participants: ctx.participants, directory: ctx.directory };
    const resolved = drafts.flat().map((d: TodoDraft): Todo => {
      const owner = resolveOwner(d, owners);
      return {
        id: "",
        title: d.title,
        ...(d.detail ? { detail: d.detail } : {}),
        ownerMention: owner.ownerMention,
        ownerSpeakerId: owner.ownerSpeakerId,
        ownerPersonId: owner.ownerPersonId,
        ownerBasis: owner.ownerBasis,
        ownerConfidence: owner.ownerConfidence,
        external: owner.external,
        dueText: d.dueText,
        due: resolveDue(d.dueText, ctx.meetingDate),
        evidence: d.evidence,
        status: "draft",
      };
    });
    const byPosition = (todo: Todo) => index.indexOf(todo.evidence[0]!);
    resolved.sort((a, b) => byPosition(a) - byPosition(b));
    const log = new IssueLog("todos");
    const merged = mergeDuplicateTodos(resolved, (id) => index.indexOf(id), (kept, dropped) =>
      log.minor(`待办「${dropped.title}」与「${kept.title}」是同一件事，已合并`),
    );
    this.record(log.items);
    return merged.map((todo, i) => Todo.parse({ ...todo, id: `t-${i + 1}` }));
  }

  /**
   * One model call with validation: repairable problems are fixed in code;
   * if the answer is unusable or mostly ungrounded, ask once more with the
   * problems listed; then accept the repaired answer or fail.
   */
  private async generate<T>(
    task: TaskName,
    system: string,
    user: string,
    interpret: (json: unknown, log: IssueLog) => T | null,
  ): Promise<T> {
    let maxTokens = MAX_TOKENS[task];
    let problems: string[] | undefined;
    let last: IssueLog | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const log = new IssueLog(task);
      let value: T | null = null;
      try {
        const res = await this.provider.completeJson({
          system,
          user: problems ? user + feedback(problems) : user,
          maxTokens,
          signal: this.options.signal,
        });
        this.usage.add(task, res.usage);
        value = interpret(res.json, log);
      } catch (err) {
        if (!(err instanceof LlmError) || err.kind !== "invalid_json") throw err;
        if (err.finishReason === "length") {
          log.fatal("输出太长被截断了，请精简每条内容");
          maxTokens *= 2;
        } else {
          log.fatal(`输出不是有效的 JSON（${err.detail ?? "解析失败"}），请只输出一个 JSON 对象`);
        }
      }
      if (value !== null && (!log.needsRetry || attempt === 2)) {
        if (attempt === 2) log.minor(`第一次输出未通过校验（${last!.items.filter((i) => i.severity !== "minor").map((i) => i.message).join("；")}），已重试`);
        this.record(log.items);
        return value;
      }
      last = log;
      problems = log.items.map((i) => i.message).slice(0, 20);
    }
    this.record(last!.items);
    throw new MinutesEngineError(task, last!.items);
  }

  private record(items: Issue[]): void {
    for (const issue of items) {
      this.issues.push(issue);
      this.options.onIssue?.(issue);
    }
  }

  private async mapParts<T>(parts: Part[], fn: (part: Part) => Promise<T>): Promise<T[]> {
    const results = new Array<T>(parts.length);
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const i = next++;
        results[i] = await fn(parts[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 4, parts.length) }, worker));
    return results;
  }

  private view(t: Transcript, ctx?: MeetingContext) {
    const speakers = ctx?.speakers?.length ? ctx.speakers : t.speakers;
    const people: People = peopleById(ctx?.participants, ctx?.directory, this.options.directory);
    const bySpeaker = new Map(speakers.map((s) => [s.id, s]));
    const lines = new Map(t.segments.map((s) => [s.id, renderSegment(s, bySpeaker, people)]));
    return {
      speakers,
      speakerList: renderSpeakers(speakers, people, ctx?.recorderId),
      line: (s: Segment) => lines.get(s.id)!,
      render: (segments: readonly Segment[]) => segments.map((s) => lines.get(s.id)!).join("\n"),
    };
  }

  /**
   * Splits a transcript that is over budget: along chapter boundaries when
   * chapters are known, and inside a chapter only when one chapter alone is
   * over budget. Under budget, one part with everything.
   */
  private plan(segments: Segment[], chapters: Chapter[], view: { line: (s: Segment) => string }): Part[] {
    const cost = segments.map((s) => estimateTokens(view.line(s)) + 1);
    const total = cost.reduce((a, b) => a + b, 0);
    if (total <= this.budget) return [{ index: 1, total: 1, segments, chapters }];

    const index = new SegmentIndex(segments);
    const blocks: [number, number][] = chapters.length
      ? chapters.map((c) => [index.indexOf(c.firstSegmentId), index.indexOf(c.lastSegmentId)] as [number, number]).filter(([a, b]) => a >= 0 && b >= a)
      : [[0, segments.length - 1]];
    const ranges: [number, number][] = [];
    let current: [number, number] | null = null;
    let used = 0;
    const flush = () => {
      if (current) ranges.push(current);
      current = null;
      used = 0;
    };
    for (const [from, to] of blocks) {
      const size = cost.slice(from, to + 1).reduce((a, b) => a + b, 0);
      if (size > this.budget) {
        flush();
        for (let i = from; i <= to; i++) {
          if (current && used + cost[i]! > this.budget) flush();
          current = current ? [current[0], i] : [i, i];
          used += cost[i]!;
        }
        flush();
        continue;
      }
      if (current && used + size > this.budget) flush();
      current = current ? [current[0], to] : [from, to];
      used += size;
    }
    flush();
    return ranges.map(([from, to], i) => ({
      index: i + 1,
      total: ranges.length,
      segments: segments.slice(from, to + 1),
      chapters: chapters.filter((c) => index.indexOf(c.lastSegmentId) >= from && index.indexOf(c.firstSegmentId) <= to),
    }));
  }
}

export function createMinutesEngine(options: MinutesEngineOptions): DefaultMinutesEngine {
  return new DefaultMinutesEngine(options);
}

function mergeDrafts(drafts: MinutesDraft[]): MinutesDraft {
  const [first] = drafts;
  if (drafts.length === 1 && first) return first;
  const unique = (points: Point[]) => points.filter((p, i) => points.findIndex((q) => q.text === p.text) === i);
  return {
    title: first?.title ?? "",
    overview: drafts.map((d) => d.overview).filter(Boolean).join(" "),
    conclusions: unique(drafts.flatMap((d) => d.conclusions)),
    decisions: unique(drafts.flatMap((d) => d.decisions)),
    openQuestions: unique(drafts.flatMap((d) => d.openQuestions)),
  };
}

const sameTitle = (a: string, b: string) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/** 2026-10-12T10:39:12+08:00 */
export function shanghaiIso(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
}
