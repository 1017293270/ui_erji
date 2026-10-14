import { estimateTokens } from "../tokens";
import { parseModelJson } from "./json";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

/** Text handed to the JSON parser as if the model had written it: test malformed output. */
export class MockRaw {
  constructor(readonly text: string) {}
}

/** An error thrown instead of answering: test provider failures. */
export class MockFailure {
  constructor(readonly error: Error) {}
}

export type MockReply = unknown | MockRaw | MockFailure | ((req: LlmRequest, call: number) => unknown);

export interface MockCall {
  /** Task read from the system prompt marker, e.g. "chapters". */
  task: string | undefined;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Every prompt's system message starts with this line; the mock routes on it. */
export const TASK_MARKER = /EchoMind 任务：([\w-]+)/;

/**
 * Canned answers per task, for tests and demos. Each task has a queue of
 * replies; calls take them in order and the last one repeats.
 */
export class MockProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly calls: MockCall[] = [];
  private readonly replies: Record<string, MockReply[]>;
  private readonly served: Record<string, number> = {};

  constructor(replies: Record<string, MockReply[]>, options: { name?: string; model?: string } = {}) {
    this.replies = replies;
    this.name = options.name ?? "mock";
    this.model = options.model ?? "mock-model";
  }

  static raw(text: string): MockRaw {
    return new MockRaw(text);
  }

  static fail(error: Error): MockFailure {
    return new MockFailure(error);
  }

  callsFor(task: string): MockCall[] {
    return this.calls.filter((c) => c.task === task);
  }

  async completeJson(req: LlmRequest): Promise<LlmResult> {
    req.signal?.throwIfAborted();
    const task = TASK_MARKER.exec(req.system)?.[1] ?? Object.keys(this.replies).find((k) => req.system.includes(k));
    this.calls.push({ task, system: req.system, user: req.user, maxTokens: req.maxTokens });
    const queue = task ? this.replies[task] : undefined;
    if (!queue?.length) throw new Error(`MockProvider: no reply for task ${task ?? "(unknown)"}`);
    const n = this.served[task!] ?? 0;
    this.served[task!] = n + 1;
    let reply = queue[Math.min(n, queue.length - 1)];
    if (typeof reply === "function") reply = (reply as (r: LlmRequest, c: number) => unknown)(req, n);
    if (reply instanceof MockFailure) throw reply.error;
    const text = reply instanceof MockRaw ? reply.text : JSON.stringify(reply);
    const json = parseModelJson(text, "Mock");
    return {
      json,
      usage: { inputTokens: estimateTokens(req.system + req.user), outputTokens: estimateTokens(text), cachedInputTokens: 0 },
    };
  }
}
