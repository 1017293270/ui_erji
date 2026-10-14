/**
 * The task-agnostic model interface. A provider takes a system prompt and a
 * user prompt, asks the model for a JSON object and returns it parsed, with
 * token usage. Everything minutes-specific lives above this line.
 */

export interface LlmRequest {
  system: string;
  user: string;
  /** Output budget for this call; providers apply their own default when omitted. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (DeepSeek: prompt_cache_hit_tokens). */
  cachedInputTokens?: number;
  /** Output tokens spent on chain-of-thought, when the model thinks. Included in outputTokens. */
  reasoningTokens?: number;
}

export interface LlmResult {
  json: unknown;
  usage: LlmUsage;
}

export interface LlmProvider {
  /** Provider id written into Generation.provider: "deepseek". */
  readonly name: string;
  /** Model id written into Generation.model: "deepseek-flash". */
  readonly model: string;
  completeJson(req: LlmRequest): Promise<LlmResult>;
}
