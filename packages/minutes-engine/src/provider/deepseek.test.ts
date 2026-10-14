import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "./deepseek";
import { LlmError, MissingApiKeyError } from "./errors";
import { OpenAICompatibleProvider, type FetchLike } from "./openai-compatible";

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

type Reply = Response | Error | (() => Response | Promise<Response>);

/** A fetch that answers from a queue and records what was sent. */
function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (!next) throw new Error("fakeFetch: no more replies");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch, sent };
}

function completion(content: string | null, opts: { finish?: string; usage?: Record<string, unknown>; prefix?: string } = {}): Response {
  const body = {
    id: "cmpl-1",
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: opts.finish ?? "stop", message: { role: "assistant", content } }],
    usage: opts.usage ?? {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 1024,
      prompt_cache_miss_tokens: 176,
      prompt_tokens_details: { cached_tokens: 1024 },
    },
  };
  return new Response((opts.prefix ?? "") + JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, message = "error", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function provider(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof DeepSeekProvider>[0]> = {}) {
  const waits: number[] = [];
  const p = new DeepSeekProvider({
    apiKey: "sk-test",
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 1,
    ...extra,
  });
  return { p, waits };
}

const REQ = { system: "系统提示：输出 JSON", user: "用户内容", maxTokens: 2048 };

async function failWith(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected the call to fail");
}

describe("DeepSeekProvider", () => {
  it("sends an OpenAI-style JSON-mode request to the official endpoint", async () => {
    const { fetch, sent } = fakeFetch(completion('{"ok":true}'));
    const { p } = provider(fetch);
    const res = await p.completeJson(REQ);

    expect(res.json).toEqual({ ok: true });
    expect(p.name).toBe("deepseek");
    expect(p.model).toBe("deepseek-flash");
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(req!.init.method).toBe("POST");
    const headers = req!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(req!.body).toEqual({
      model: "deepseek-flash",
      messages: [
        { role: "system", content: REQ.system },
        { role: "user", content: REQ.user },
      ],
      stream: false,
      max_tokens: 2048,
      temperature: 0.3,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
  });

  it("maps usage, including context-cache hits", async () => {
    const { fetch } = fakeFetch(
      completion("{}"),
      completion("{}", { usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 32 } } }),
      completion("{}", { usage: { prompt_tokens: 50, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 800 } } }),
    );
    const { p } = provider(fetch);
    expect((await p.completeJson(REQ)).usage).toEqual({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1024 });
    // Servers that only fill the OpenAI field.
    expect((await p.completeJson(REQ)).usage).toEqual({ inputTokens: 50, outputTokens: 7, cachedInputTokens: 32 });
    expect((await p.completeJson(REQ)).usage).toEqual({ inputTokens: 50, outputTokens: 900, reasoningTokens: 800 });
  });

  it("retries 429 with backoff, then succeeds", async () => {
    const { fetch, sent } = fakeFetch(failure(429, "Rate limit reached"), completion('{"n":1}'));
    const { p, waits } = provider(fetch);
    const res = await p.completeJson(REQ);
    expect(res.json).toEqual({ n: 1 });
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("honours Retry-After", async () => {
    const { fetch } = fakeFetch(failure(429, "slow down", { "Retry-After": "7" }), completion("{}"));
    const { p, waits } = provider(fetch);
    await p.completeJson(REQ);
    expect(waits).toEqual([7000]);
  });

  it("retries 500 / 503 / network errors with growing waits", async () => {
    const { fetch, sent } = fakeFetch(failure(500), failure(503, "Server overloaded"), new TypeError("fetch failed"), completion("{}"));
    const { p, waits } = provider(fetch);
    await p.completeJson(REQ);
    expect(sent).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("gives up after maxRetries with the last error's kind", async () => {
    const { fetch, sent } = fakeFetch(failure(503), failure(503), failure(503), failure(503), failure(503));
    const { p } = provider(fetch);
    const err = await failWith(p.completeJson(REQ));
    expect(sent).toHaveLength(4); // first try + 3 retries
    expect(err.kind).toBe("server");
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toContain("DeepSeek 服务暂时不可用");
  });

  it.each([
    [401, "auth", "鉴权失败"],
    [402, "balance", "余额不足"],
    [400, "bad_request", "参数有误"],
    [422, "bad_request", "参数有误"],
  ] as const)("does not retry %s → %s", async (status, kind, text) => {
    const { fetch, sent } = fakeFetch(failure(status, "Authentication Fails"), completion("{}"));
    const { p, waits } = provider(fetch);
    const err = await failWith(p.completeJson(REQ));
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(false);
    expect(err.userMessage).toContain(text);
    expect(err.detail).toBe("Authentication Fails");
  });

  it("reports a network failure after retries", async () => {
    const { fetch, sent } = fakeFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
    const { p } = provider(fetch, { maxRetries: 1 });
    const err = await failWith(p.completeJson(REQ));
    expect(sent).toHaveLength(2);
    expect(err.kind).toBe("network");
    expect(err.userMessage).toContain("无法连接 DeepSeek");
  });

  it("times out a hung request as a network error", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const { p } = provider(hang, { timeoutMs: 20, maxRetries: 0 });
    const err = await failWith(p.completeJson(REQ));
    expect(err.kind).toBe("network");
    expect(err.detail).toContain("秒未完成");
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const { p } = provider(hang);
    const pending = p.completeJson({ ...REQ, signal: controller.signal });
    controller.abort(new Error("用户取消"));
    await expect(pending).rejects.toThrow("用户取消");
  });

  it("tolerates keep-alive blank lines before the body", async () => {
    const { fetch } = fakeFetch(completion('{"a":1}', { prefix: "\n\n\n" }));
    const { p } = provider(fetch);
    expect((await p.completeJson(REQ)).json).toEqual({ a: 1 });
  });

  it("retries empty JSON-mode content once", async () => {
    const { fetch, sent } = fakeFetch(completion(""), completion('{"b":2}'));
    const { p, waits } = provider(fetch);
    expect((await p.completeJson(REQ)).json).toEqual({ b: 2 });
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([]);
  });

  it("fails as invalid_json when the content stays empty", async () => {
    const { fetch, sent } = fakeFetch(completion(null), completion("  "));
    const { p } = provider(fetch);
    const err = await failWith(p.completeJson(REQ));
    expect(sent).toHaveLength(2);
    expect(err.kind).toBe("invalid_json");
  });

  it("does not retry malformed or truncated JSON (the engine decides)", async () => {
    const { fetch, sent } = fakeFetch(completion('{"a": [1, 2'), completion('{"a": [1, 2', { finish: "length" }));
    const { p } = provider(fetch);
    const bad = await failWith(p.completeJson(REQ));
    expect(bad.kind).toBe("invalid_json");
    const cut = await failWith(p.completeJson(REQ));
    expect(cut.kind).toBe("invalid_json");
    expect(cut.finishReason).toBe("length");
    expect(cut.userMessage).toContain("截断");
    expect(sent).toHaveLength(2);
  });

  it("unwraps a fenced JSON reply", async () => {
    const { fetch } = fakeFetch(completion('好的：\n```json\n{"c":3}\n```'));
    const { p } = provider(fetch);
    expect((await p.completeJson(REQ)).json).toEqual({ c: 3 });
  });

  it("treats insufficient_system_resource as a retryable server error and content_filter as final", async () => {
    const { fetch, sent } = fakeFetch(completion("", { finish: "insufficient_system_resource" }), completion('{"d":4}'));
    const { p } = provider(fetch);
    expect((await p.completeJson(REQ)).json).toEqual({ d: 4 });
    expect(sent).toHaveLength(2);

    const filtered = fakeFetch(completion("", { finish: "content_filter" }));
    const err = await failWith(provider(filtered.fetch).p.completeJson(REQ));
    expect(err.kind).toBe("bad_request");
    expect(err.userMessage).toContain("内容安全");
  });

  it("treats a gateway's non-JSON 200 as a server error", async () => {
    const { fetch } = fakeFetch(new Response("<html>bad gateway</html>", { status: 200 }), completion("{}"));
    const { p } = provider(fetch);
    expect((await p.completeJson(REQ)).json).toEqual({});
  });

  describe("configuration", () => {
    it("requires an API key", () => {
      expect(() => new DeepSeekProvider({ apiKey: undefined })).toThrow(MissingApiKeyError);
      expect(() => DeepSeekProvider.fromEnv({})).toThrow(/DEEPSEEK_API_KEY/);
      expect(() => DeepSeekProvider.fromEnv({ DEEPSEEK_API_KEY: "  " })).toThrow(MissingApiKeyError);
    });

    it("reads base URL and model from the environment", async () => {
      const { fetch, sent } = fakeFetch(completion("{}"));
      const p = DeepSeekProvider.fromEnv(
        { DEEPSEEK_API_KEY: "sk-env", DEEPSEEK_BASE_URL: "https://proxy.example.cn/v1/", DEEPSEEK_MODEL: "deepseek-v4-pro" },
        { fetch },
      );
      await p.completeJson(REQ);
      expect(p.model).toBe("deepseek-v4-pro");
      expect(sent[0]!.url).toBe("https://proxy.example.cn/v1/chat/completions");
      expect(sent[0]!.body.model).toBe("deepseek-v4-pro");
      expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-env");
    });

    it("thinking mode: enabled in the body, no temperature, room for the chain-of-thought", async () => {
      const { fetch, sent } = fakeFetch(completion("{}"));
      const p = DeepSeekProvider.fromEnv({ DEEPSEEK_API_KEY: "sk", DEEPSEEK_THINKING: "1" }, { fetch });
      await p.completeJson(REQ);
      expect(sent[0]!.body.thinking).toEqual({ type: "enabled" });
      expect(sent[0]!.body.temperature).toBeUndefined();
      expect(sent[0]!.body.max_tokens).toBe(2048 + 16384);
    });
  });
});

describe("OpenAICompatibleProvider", () => {
  it("serves other OpenAI-compatible endpoints, e.g. a private vLLM without a key", async () => {
    const { fetch, sent } = fakeFetch(completion('{"e":5}'));
    const p = new OpenAICompatibleProvider({
      name: "vllm",
      label: "私有化模型",
      baseUrl: "http://10.0.0.8:8000/v1",
      model: "deepseek-ai/DeepSeek-V4-Flash",
      extraBody: { chat_template_kwargs: { thinking: false } },
      fetch,
    });
    expect((await p.completeJson(REQ)).json).toEqual({ e: 5 });
    expect(sent[0]!.url).toBe("http://10.0.0.8:8000/v1/chat/completions");
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(sent[0]!.body.chat_template_kwargs).toEqual({ thinking: false });
    expect(sent[0]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("treats a 429 about quota as balance, not rate limit", async () => {
    const { fetch, sent } = fakeFetch(
      new Response(JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }), { status: 429 }),
    );
    const p = new OpenAICompatibleProvider({ name: "qwen", label: "通义千问", baseUrl: "https://example.cn/v1", model: "qwen", fetch });
    const err = await failWith(p.completeJson(REQ));
    expect(err.kind).toBe("balance");
    expect(err.userMessage).toContain("通义千问");
    expect(sent).toHaveLength(1);
  });
});
