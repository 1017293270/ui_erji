import { MissingApiKeyError } from "./errors";
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible";

/** OpenAI-format endpoint; the API also serves an Anthropic-format one at /anthropic, which we do not use. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek-V4.1-Flash, as of 2026-10. The legacy names deepseek-chat and
 * deepseek-reasoner were scheduled for retirement on 2026-07-24 and must not
 * be used; deepseek-v4-flash is still accepted and routed to V4.1-Flash.
 * See README for what was checked and when.
 */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

/** Room added to max_tokens for the chain-of-thought when thinking mode is on. */
const THINKING_BUDGET = 16_384;

export interface DeepSeekOptions
  extends Partial<Omit<OpenAICompatibleOptions, "name" | "label" | "baseUrl" | "model" | "apiKey">> {
  apiKey: string | undefined;
  baseUrl?: string;
  model?: string;
  /**
   * DeepSeek's current models think by default. Extraction with a JSON
   * example does not need it, so we turn it off unless asked: cheaper,
   * faster, and temperature only takes effect in non-thinking mode.
   */
  thinking?: boolean;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly thinking: boolean;

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey?.trim()) {
      throw new MissingApiKeyError("DEEPSEEK_API_KEY", "DeepSeek", "https://platform.deepseek.com/api_keys");
    }
    const { apiKey, baseUrl, model, thinking = false, extraBody, ...rest } = options;
    super({
      defaultMaxTokens: 4096,
      // DeepSeek's docs recommend 1.0 for data analysis; we go lower so repeated runs agree more.
      temperature: thinking ? undefined : 0.3,
      extraMaxTokens: thinking ? THINKING_BUDGET : 0,
      ...rest,
      name: "deepseek",
      label: "DeepSeek",
      apiKey: apiKey.trim(),
      baseUrl: baseUrl?.trim() || DEEPSEEK_BASE_URL,
      model: model?.trim() || DEEPSEEK_DEFAULT_MODEL,
      extraBody: { thinking: { type: thinking ? "enabled" : "disabled" }, ...extraBody },
    });
    this.thinking = thinking;
  }

  /**
   * DEEPSEEK_API_KEY (required), DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,
   * DEEPSEEK_THINKING=1 to turn thinking mode on, DEEPSEEK_TIMEOUT_MS.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    overrides: Partial<DeepSeekOptions> = {},
  ): DeepSeekProvider {
    const timeout = Number(env.DEEPSEEK_TIMEOUT_MS);
    return new DeepSeekProvider({
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
      thinking: /^(1|true|on|enabled|yes)$/i.test(env.DEEPSEEK_THINKING ?? ""),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
      ...overrides,
    });
  }
}
