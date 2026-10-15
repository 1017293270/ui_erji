import { Agent, fetch as undiciFetch } from "undici";
import type { Fetch } from "./feishu/client";

/**
 * DeepSeek, proxied for the desktop's minutes engine. The body goes through as is (only the
 * model is pinned) and the reply comes back as is, so retries stay in the engine. Bodies are
 * never logged: they are meeting transcripts.
 */

/** Minutes for a long meeting can take minutes to generate; Node's fetch gives up on headers at 5. */
const TIMEOUT_MS = 600_000;
const agent = new Agent({ connect: { timeout: 15_000 }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });
const defaultFetch: Fetch = (input, init) => undiciFetch(input, { ...(init as object), dispatcher: agent }) as unknown as Promise<Response>;

export type LlmDeps = { apiKey: string | null; baseUrl: string; model: string; fetch?: Fetch };

export type Upstream = { status: number; body: string; usage: { promptTokens?: number; completionTokens?: number } };

export class LlmUnreachable extends Error {}

export async function proxyChat(llm: LlmDeps & { apiKey: string }, body: Record<string, unknown>): Promise<Upstream> {
  let response: Response;
  let text: string;
  try {
    response = await (llm.fetch ?? defaultFetch)(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || /timeout/i.test(e.name));
    throw new LlmUnreachable(
      timeout ? `DeepSeek 在 ${TIMEOUT_MS / 60_000} 分钟内没有回复，请稍后再试。` : "EchoMind 服务器暂时连不上 DeepSeek，请稍后再试。",
    );
  }
  let usage: Upstream["usage"] = {};
  try {
    const u = JSON.parse(text)?.usage;
    usage = { promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens };
  } catch {
    // Not JSON: passed through untouched all the same.
  }
  return { status: response.status, body: text, usage };
}

/** At most `max` calls per `windowMs` for each key. In memory: there is one api process. */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    // Keys are people or addresses; forget the quiet ones before the map grows large.
    if (this.hits.size > 10_000) {
      for (const [k, times] of this.hits) if (!times.some((t) => t > now - this.windowMs)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    const allowed = recent.length < this.max;
    if (allowed) recent.push(now);
    this.hits.set(key, recent);
    return allowed;
  }

  /** Takes back the last call counted for `key`: it turned out not to count. */
  refund(key: string): void {
    this.hits.get(key)?.pop();
  }
}
