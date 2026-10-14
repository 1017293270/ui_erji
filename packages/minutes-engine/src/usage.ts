import type { LlmUsage } from "./provider/types";

export interface TaskUsage extends Required<Omit<LlmUsage, "reasoningTokens">> {
  calls: number;
  reasoningTokens: number;
}

export interface PipelineUsage extends TaskUsage {
  byTask: Record<string, TaskUsage>;
}

const empty = (): TaskUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });

/** Adds up token usage across calls, per task and in total. */
export class UsageMeter {
  private readonly total = empty();
  private readonly tasks: Record<string, TaskUsage> = {};

  add(task: string, usage: LlmUsage): void {
    for (const bucket of [this.total, (this.tasks[task] ??= empty())]) {
      bucket.calls += 1;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cachedInputTokens += usage.cachedInputTokens ?? 0;
      bucket.reasoningTokens += usage.reasoningTokens ?? 0;
    }
  }

  snapshot(): PipelineUsage {
    const byTask: Record<string, TaskUsage> = {};
    for (const [task, u] of Object.entries(this.tasks)) byTask[task] = { ...u };
    return { ...this.total, byTask };
  }
}
