export type LlmErrorKind =
  | "auth" // 401：API Key 错误
  | "balance" // 402：余额不足
  | "rate_limit" // 429：并发 / 频率超限
  | "bad_request" // 400 / 422 / 内容被拦截：改请求才能好
  | "server" // 5xx、资源不足：稍后重试
  | "network" // 连不上、超时
  | "invalid_json"; // 返回了，但不是可用的 JSON（空内容、被截断、格式错）

export interface LlmErrorInit {
  kind: LlmErrorKind;
  /** Provider label for messages: DeepSeek, 通义千问… */
  provider: string;
  status?: number;
  /** What the server or parser said, for logs. */
  detail?: string;
  /** OpenAI-style finish_reason when the reply came back but was unusable. */
  finishReason?: string;
  /** Server-suggested wait before retrying (Retry-After). */
  retryAfterMs?: number;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(["rate_limit", "server", "network"]);

/** A model call that failed, sorted into what the caller can do about it. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly detail?: string;
  readonly finishReason?: string;
  readonly retryAfterMs?: number;
  /** Worth retrying the same request later. */
  readonly retryable: boolean;
  /** One sentence in Chinese for the person using the app. */
  readonly userMessage: string;

  constructor(init: LlmErrorInit) {
    const userMessage = userMessageFor(init);
    super(init.detail ? `${userMessage}（${init.detail}）` : userMessage, { cause: init.cause });
    this.name = "LlmError";
    this.kind = init.kind;
    this.provider = init.provider;
    this.status = init.status;
    this.detail = init.detail;
    this.finishReason = init.finishReason;
    this.retryAfterMs = init.retryAfterMs;
    this.retryable = RETRYABLE.has(init.kind);
    this.userMessage = userMessage;
  }
}

/** A provider was built without the key it needs. The message says how to set it. */
export class MissingApiKeyError extends Error {
  readonly envVar: string;
  constructor(envVar: string, provider: string, consoleUrl?: string) {
    super(
      `未设置 ${envVar}，无法调用 ${provider}。` +
        (consoleUrl ? `请在 ${consoleUrl} 创建 API Key，` : "请") +
        `然后在终端执行 export ${envVar}=<你的 Key> 后重试。`,
    );
    this.name = "MissingApiKeyError";
    this.envVar = envVar;
  }
}

function userMessageFor({ kind, provider, status, finishReason }: LlmErrorInit): string {
  const code = status ? `（${status}）` : "";
  switch (kind) {
    case "auth":
      return `${provider} 鉴权失败${code}：API Key 不正确或已失效，请检查密钥配置。`;
    case "balance":
      return `${provider} 账户余额不足${code}，请充值后重试。`;
    case "rate_limit":
      return `${provider} 请求过于频繁${code}，已自动重试仍未成功，请稍后再试。`;
    case "bad_request":
      if (finishReason === "content_filter") return `${provider} 的内容安全策略拦截了这次生成，请检查会议内容后重试。`;
      return `发给 ${provider} 的请求参数有误${code}，请检查模型名称和参数配置。`;
    case "server":
      return `${provider} 服务暂时不可用${code}，已自动重试仍未成功，请稍后再试。`;
    case "network":
      return `无法连接 ${provider}（网络错误或超时），请检查网络后重试。`;
    case "invalid_json":
      if (finishReason === "length") return `${provider} 的输出超出长度上限被截断，没有得到完整的 JSON。`;
      return `${provider} 返回的内容不是有效的 JSON。`;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
