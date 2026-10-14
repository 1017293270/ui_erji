import { Transcript, type Meeting, type Minutes, type Person, type Todo } from "@echomind/shared";
import { createMinutesEngine, type MeetingContext } from "./engine";
import type { LlmProvider } from "./provider/types";
import type { PipelineUsage } from "./usage";
import type { Issue } from "./validate/issues";

export type PipelineStep = "chapters" | "minutes" | "todos";

export interface PipelineOptions {
  provider: LlmProvider;
  /** Company directory plus known outside contacts; participants are looked up here. */
  directory: Person[];
  signal?: AbortSignal;
  maxTranscriptTokens?: number;
  now?: () => Date;
  onProgress?: (step: PipelineStep, state: "start" | "done") => void;
}

export interface PipelineResult {
  minutes: Minutes;
  todos: Todo[];
  usage: PipelineUsage;
  /** Everything code repaired or rejected in the model's answers. */
  issues: Issue[];
}

/** Context for the engine from a stored meeting. Participants missing from the directory are skipped. */
export function meetingContext(meeting: Meeting, directory: Person[]): MeetingContext {
  const byId = new Map(directory.map((p) => [p.id, p]));
  return {
    meetingDate: meeting.startedAt,
    participants: meeting.participantIds.map((id) => byId.get(id)).filter((p): p is Person => !!p),
    directory,
    recorderId: meeting.recorderId,
    speakers: meeting.transcript?.speakers ?? [],
    meetingTitle: meeting.title,
  };
}

/** Chapters first, then minutes and todos side by side. */
export async function runPipeline(meeting: Meeting, options: PipelineOptions): Promise<PipelineResult> {
  if (!meeting.transcript?.segments.length) throw new Error("这场会议还没有逐字稿，无法生成纪要。");
  const transcript = Transcript.parse(meeting.transcript);
  const ctx = meetingContext(meeting, options.directory);

  // If one branch fails, stop the other instead of paying for it.
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const engine = createMinutesEngine({
    provider: options.provider,
    directory: options.directory,
    maxTranscriptTokens: options.maxTranscriptTokens,
    signal: controller.signal,
    now: options.now,
  });
  const step = async <T>(name: PipelineStep, run: () => Promise<T>): Promise<T> => {
    options.onProgress?.(name, "start");
    try {
      const out = await run();
      options.onProgress?.(name, "done");
      return out;
    } catch (err) {
      controller.abort(err);
      throw err;
    }
  };

  try {
    const chapters = await step("chapters", () => engine.chapters(transcript, ctx));
    const [minutes, todos] = await Promise.all([
      step("minutes", () => engine.minutes(transcript, chapters, ctx)),
      step("todos", () => engine.todos(transcript, ctx, chapters)),
    ]);
    return { minutes, todos, usage: engine.usage.snapshot(), issues: engine.issues };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
