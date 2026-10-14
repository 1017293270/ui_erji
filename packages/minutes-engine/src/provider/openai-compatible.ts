import { isAbortError, LlmError, type LlmErrorKind } from "./errors";
import { parseModelJson } from "./json";
import type { LlmProvider, LlmRequest, LlmResult, LlmUsage } from "./types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleOptions {
  /** Provider id, written into Generation.provider: deepseek, qwen, vllm. */
  name: string;
  /** Name used in Chinese error messages: DeepSeek, 通义千问, 私有化模型. Defaults to `name`. */
  label?: string;
  /**
   * Base URL up to, not including, /chat/completions:
   * https://api.deepseek.com, https://dashscope.aliyuncs.com/compatible-mode/v1, http://10.0.0.8:8000/v1.
   */
  baseUrl: string;
  /** Sent as a Bearer token. Private endpoints may not need one. */
  apiKey?: string;
  model: string;
  temperature?: number;
  /** max_tokens when a request does not set one. */
  defaultMaxTokens?: number;
  /** Added to every request's max_tokens, e.g. room for a thinking model's chain-of-thought. */
  extraMaxTokens?: number;
  /** Provider-specific body fields merged into every request: DeepSeek `thinking`, Qwen `enable_thinking`. */
  extraBody?: Record<string, unknown>;
  /** Send response_format: {type: "json_object"}. Default true; turn off for servers without JSON mode. */
  jsonMode?: boolean;
  headers?: Record<string, string>;
  /** Per-attempt timeout. Default 300 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** First backoff step; doubles each retry, with jitter. Default 1 s. */
  retryBaseMs?: number;
  /** Ceiling for one backoff step, and for a server's Retry-After. Default 30 s. */
  retryMaxMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

/** What the request body looks like; exported for tests and logging. */
export interface ChatCompletionBody {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  stream: false;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" };
  [extra: string]: unknown;
}

/**
 * Any server that speaks the OpenAI Chat Completions protocol: DeepSeek,
 * Qwen (DashScope compatible mode), or a private vLLM / SGLang deployment of
 * open weights. Plain fetch, no SDK.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly label: string;
  protected readonly options: OpenAICompatibleOptions;
  private readonly endpoint: string;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.name = options.name;
    this.model = options.model;
    this.label = options.label ?? options.name;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  buildBody(req: LlmRequest): ChatCompletionBody {
    const o = this.options;
    const maxTokens = req.maxTokens ?? o.defaultMaxTokens;
    const body: ChatCompletionBody = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      stream: false,
    };
    if (maxTokens !== undefined) body.max_tokens = maxTokens + (o.extraMaxTokens ?? 0);
    if (o.temperature !== undefined) body.temperature = o.temperature;
    if (o.jsonMode !== false) body.response_format = { type: "json_object" };
    return { ...body, ...o.extraBody };
  }

  async completeJson(req: LlmRequest): Promise<LlmResult> {
    const body = JSON.stringify(this.buildBody(req));
    const maxRetries = this.options.maxRetries ?? 3;
    let emptyRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(body, req.signal);
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        if (!(err instanceof LlmError)) throw err;
        // JSON mode occasionally returns empty content (documented by DeepSeek): one free retry.
        const empty = err.kind === "invalid_json" && err.finishReason !== "length" && err.detail === EMPTY;
        if (empty && !emptyRetried) {
          emptyRetried = true;
          continue;
        }
        if (!err.retryable || attempt >= maxRetries) throw err;
        await this.wait(this.backoff(attempt, err.retryAfterMs), req.signal);
      }
    }
  }

  private async attempt(body: string, signal?: AbortSignal): Promise<LlmResult> {
    const o = this.options;
    const timeoutMs = o.timeoutMs ?? 300_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...o.headers,
    };
    if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;

    let res: Response;
    let text: string;
    try {
      res = await (o.fetch ?? fetch)(this.endpoint, { method: "POST", headers, body, signal: combined });
      // Non-streaming DeepSeek responses may start with keep-alive blank lines; text() + trim copes.
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      const timedOut = timeout.aborted || isAbortError(err);
      throw new LlmError({
        kind: "network",
        provider: this.label,
        detail: timedOut ? `请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成` : errorText(err),
        cause: err,
      });
    }

    if (!res.ok) throw this.httpError(res, text);

    let data: ChatCompletionResponse;
    try {
      data = JSON.parse(text.trim()) as ChatCompletionResponse;
    } catch (err) {
      throw new LlmError({ kind: "server", provider: this.label, status: res.status, detail: "响应不是 JSON", cause: err });
    }
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new LlmError({ kind: "server", provider: this.label, status: res.status, detail: "响应缺少 choices" });
    }
    const finishReason = choice.finish_reason ?? undefined;
    if (finishReason === "insufficient_system_resource" || finishReason === "aborted") {
      throw new LlmError({ kind: "server", provider: this.label, finishReason, detail: `finish_reason=${finishReason}` });
    }
    if (finishReason === "content_filter") {
      throw new LlmError({ kind: "bad_request", provider: this.label, finishReason, detail: "finish_reason=content_filter" });
    }
    const content = choice.message.content;
    if (!content || !content.trim()) {
      throw new LlmError({ kind: "invalid_json", provider: this.label, finishReason, detail: EMPTY });
    }
    const json = parseModelJson(content, this.label, finishReason);
    return { json, usage: mapUsage(data.usage) };
  }

  private httpError(res: Response, text: string): LlmError {
    const { message, code } = errorBody(text);
    const status = res.status;
    let kind: LlmErrorKind;
    if (status === 401 || status === 403) kind = "auth";
    else if (status === 402) kind = "balance";
    else if (status === 429) kind = /quota|balance|arrear/i.test(`${code} ${message}`) ? "balance" : "rate_limit";
    else if (status === 408) kind = "network";
    else if (status >= 500) kind = "server";
    else kind = "bad_request"; // 400, 404 (wrong model / base URL), 413, 422
    return new LlmError({
      kind,
      provider: this.label,
      status,
      detail: message ?? `HTTP ${status}`,
      retryAfterMs: retryAfter(res.headers.get("retry-after")),
    });
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    const base = this.options.retryBaseMs ?? 1000;
    const cap = this.options.retryMaxMs ?? 30_000;
    const exp = Math.min(cap, base * 2 ** attempt);
    const jittered = exp * (0.5 + 0.5 * (this.options.random ?? Math.random)());
    return retryAfterMs !== undefined ? Math.min(cap, Math.max(retryAfterMs, jittered)) : jittered;
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms, signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

const EMPTY = "模型返回了空内容";

interface ChatCompletionResponse {
  choices?: { finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  };
}

/** OpenAI usage → ours. DeepSeek reports cache hits twice; other servers only in prompt_tokens_details. */
export function mapUsage(u: ChatCompletionResponse["usage"]): LlmUsage {
  const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens;
  const input = u?.prompt_tokens ?? (u?.prompt_cache_hit_tokens ?? 0) + (u?.prompt_cache_miss_tokens ?? 0);
  const usage: LlmUsage = { inputTokens: input, outputTokens: u?.completion_tokens ?? 0 };
  if (hit !== undefined) usage.cachedInputTokens = hit;
  const reasoning = u?.completion_tokens_details?.reasoning_tokens;
  if (reasoning) usage.reasoningTokens = reasoning;
  return usage;
}

function errorBody(text: string): { message?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } | string; message?: string };
    if (typeof parsed.error === "string") return { message: parsed.error };
    return {
      message: parsed.error?.message ?? parsed.message,
      code: parsed.error?.code ?? parsed.error?.type,
    };
  } catch {
    const trimmed = text.trim();
    return { message: trimmed ? trimmed.slice(0, 200) : undefined };
  }
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}
